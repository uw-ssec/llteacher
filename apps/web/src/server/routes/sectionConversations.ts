import { type Context } from "hono";
import { makeDb } from "../../db/client";
import { UUID_RE } from "../utils/uuid";
import {
  startSectionConversation,
  restartSectionConversation,
  getSectionConversationById,
  getActiveSectionConversation,
  getSectionConversationMessages,
  canReadSectionConversation,
  SectionConversationExistsError,
  SectionNotFoundError,
  SectionNotInteractiveError,
  ConversationNotFoundError,
  NotConversationOwnerError,
} from "../repositories/sectionConversations";
import { getOrgScopeForCourse } from "../repositories/organizations";
import { SubmissionGradedError } from "../repositories/submissions";
import { courseScopeFromAuthContext } from "../repositories/scope";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";

/* --------------------------------------------------------------------------
   Section-conversation routes (#27).

   Separate from routes/conversations.ts (tutor conversations, PR #212) --
   different resource, different access rules, and keeping them apart avoids
   two branches rewriting one file.
   -------------------------------------------------------------------------- */

/** True only when the caller's membership in this course is `student`.
 *
 *  #237: deliberately not `!authContext.isInstructorOf(courseId)`. That
 *  predicate is backed by AUTHOR_ROLES (instructor, admin), so a `ta` or
 *  `observer` fails it and would be classified as a student. Roles other
 *  than student are never doing the assignment, so the safe default for an
 *  unrecognized or missing membership is "not a student" -- a conversation
 *  wrongly marked as a teacher test is merely unsubmittable, whereas one
 *  wrongly marked as a student's pollutes real coursework. */
function isStudentOf(authContext: AuthContext, courseId: string): boolean {
  const membership = authContext.memberships.find((m) => m.courseId === courseId);
  return membership?.role === "student";
}

/** Shared shape for "the id in the path isn't even a UUID". Returns the same
 *  body a genuine miss returns, so shape is never an existence oracle --
 *  the SEC-020/#211 rule, applied here from the start rather than retrofitted. */
function notFound(c: Context<AppEnv>) {
  return c.json({ error: "Conversation not found" }, 404);
}

export async function startSectionConversationHandler(c: Context<AppEnv>) {
  const courseId = c.req.param("courseId");
  const sectionId = c.req.param("sectionId");
  const authContext = c.get("authContext") as AuthContext | undefined;

  const scope = authContext && courseId ? courseScopeFromAuthContext(authContext, courseId) : null;
  if (!scope || !authContext) {
    return c.json({ error: "Course access denied" }, 403);
  }
  if (!sectionId || !UUID_RE.test(sectionId)) {
    return c.json({ error: "Section not found" }, 404);
  }

  const db = makeDb(c.env.DATABASE_URL);
  try {
    const created = await startSectionConversation(db, scope, {
      sectionId,
      ownerUserId: authContext.session.userId,
      // #27/#237: anyone who is not a student working this section is
      // testing it, not doing it. Derived from the caller's actual course
      // role rather than isInstructorOf, whose AUTHOR_ROLES tier is
      // instructor+admin only -- a TA or observer would otherwise be
      // recorded as a student and their conversation would be submittable.
      // Recorded now rather than derived later; see the isTeacherTest
      // column comment for why storing beats deriving.
      isTeacherTest: !isStudentOf(authContext, courseId!),
    });
    return c.json(created, 201);
  } catch (err) {
    if (err instanceof SectionConversationExistsError) {
      // 409, not 400: the request is well-formed and the caller is allowed,
      // the resource just already exists. The client's move is to GET it.
      return c.json({ error: err.message }, 409);
    }
    // #241: the section exists and the caller can see it -- it just never
    // holds a conversation. Reporting that as 404 contradicts the homework
    // detail response the client already rendered.
    if (err instanceof SectionNotInteractiveError) {
      return c.json({ error: err.message }, 409);
    }
    // Non-member owner and section-outside-course collapse to one 404, so a
    // caller can't probe which sections exist in courses they can see.
    if (err instanceof SectionNotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    // #236: anything else is not a refusal this route knows how to
    // translate -- a dropped connection, a constraint nobody anticipated.
    // Rethrow so app.onError logs it and answers 503, instead of reporting
    // an outage to the client as a routine not-found.
    throw err;
  }
}

export async function getActiveSectionConversationHandler(c: Context<AppEnv>) {
  const courseId = c.req.param("courseId");
  const sectionId = c.req.param("sectionId");
  const authContext = c.get("authContext") as AuthContext | undefined;

  const scope = authContext && courseId ? courseScopeFromAuthContext(authContext, courseId) : null;
  if (!scope || !authContext) {
    return c.json({ error: "Course access denied" }, 403);
  }
  if (!sectionId || !UUID_RE.test(sectionId)) {
    return c.json({ error: "Section not found" }, 404);
  }

  const db = makeDb(c.env.DATABASE_URL);
  const conversation = await getActiveSectionConversation(
    db,
    scope,
    sectionId,
    authContext.session.userId,
  );
  // Not an error: "you have not started this section yet" is an ordinary
  // state the client renders as a start affordance.
  if (!conversation) return c.json({ conversation: null, messages: [] });

  const messages = await getSectionConversationMessages(db, conversation.id);
  return c.json({
    conversation: {
      id: conversation.id,
      title: conversation.title,
      sectionId: conversation.sectionId,
      isTeacherTest: conversation.isTeacherTest,
      createdAt: conversation.createdAt.toISOString(),
    },
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      parts: m.parts,
      createdAt: m.createdAt.toISOString(),
    })),
  });
}

export async function getSectionConversationHandler(c: Context<AppEnv>) {
  const courseId = c.req.param("courseId");
  const conversationId = c.req.param("conversationId");
  const authContext = c.get("authContext") as AuthContext | undefined;

  const scope = authContext && courseId ? courseScopeFromAuthContext(authContext, courseId) : null;
  if (!scope || !authContext) {
    return c.json({ error: "Course access denied" }, 403);
  }
  if (!conversationId || !UUID_RE.test(conversationId)) {
    return notFound(c);
  }

  const db = makeDb(c.env.DATABASE_URL);
  const conversation = await getSectionConversationById(db, scope, conversationId);
  if (!conversation) return notFound(c);

  const allowed = canReadSectionConversation(conversation, {
    userId: authContext.session.userId,
    isInstructor: authContext.isInstructorOf(courseId!),
  });
  // 404 rather than 403: an instructor's private test conversation should not
  // confirm its own existence to another instructor, and a student probing
  // ids should learn nothing from the status code.
  if (!allowed) return notFound(c);

  const messages = await getSectionConversationMessages(db, conversation.id);
  return c.json({
    conversation: {
      id: conversation.id,
      title: conversation.title,
      sectionId: conversation.sectionId,
      ownerUserId: conversation.ownerUserId,
      isTeacherTest: conversation.isTeacherTest,
      isDeleted: conversation.isDeleted,
      createdAt: conversation.createdAt.toISOString(),
    },
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      parts: m.parts,
      createdAt: m.createdAt.toISOString(),
    })),
  });
}

export async function restartSectionConversationHandler(c: Context<AppEnv>) {
  const courseId = c.req.param("courseId");
  const conversationId = c.req.param("conversationId");
  const authContext = c.get("authContext") as AuthContext | undefined;

  const scope = authContext && courseId ? courseScopeFromAuthContext(authContext, courseId) : null;
  if (!scope || !authContext) {
    return c.json({ error: "Course access denied" }, 403);
  }
  if (!conversationId || !UUID_RE.test(conversationId)) {
    return notFound(c);
  }

  const db = makeDb(c.env.DATABASE_URL);
  // Restarting voids a submission, which is an org-scoped write. #239: the
  // org comes from the course named in the path, not from the caller's
  // membership list -- a course belongs to exactly one org, whereas
  // getOrgScopesForUser(...)[0] picks an arbitrary one and silently 404s a
  // legitimate restart for anyone who belongs to more than one.
  const orgScope = await getOrgScopeForCourse(db, courseId!);
  if (!orgScope) return c.json({ error: "Course access denied" }, 403);

  try {
    const result = await restartSectionConversation(
      db,
      orgScope,
      conversationId,
      authContext.session.userId,
    );
    return c.json(
      {
        conversation: result.conversation,
        voidedSubmission: result.voidedSubmission
          ? {
              id: result.voidedSubmission.id,
              submittedAt: result.voidedSubmission.submittedAt.toISOString(),
            }
          : null,
      },
      201,
    );
  } catch (err) {
    if (err instanceof SubmissionGradedError) {
      // 409: the caller owns it and the request is well-formed; the section
      // has simply moved past the point where starting over is allowed.
      // Distinguishable from the 404s below because it tells the student
      // something actionable about their own work.
      return c.json({ error: err.message }, 409);
    }
    // "not found or not accessible" and "not owned by requester" collapse to
    // one 404 -- the same reasoning submitSectionHandler documents: a
    // non-owner must not be able to tell the two apart and learn that a
    // conversation exists.
    if (err instanceof ConversationNotFoundError || err instanceof NotConversationOwnerError) {
      return notFound(c);
    }
    // #236: see startSectionConversationHandler -- unexpected failures must
    // reach app.onError rather than being laundered into a 404.
    throw err;
  }
}
