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
  isStudentInCourse,
  SectionConversationExistsError,
  SectionNotFoundError,
  SectionNotInteractiveError,
  ConversationNotFoundError,
  NotConversationOwnerError,
} from "../repositories/sectionConversations";
import { getOrgScopeForCourse } from "../repositories/organizations";
import { SubmissionGradedError } from "../repositories/submissions";
import { getSectionPromptContext, SECTION_CONVERSATION_PROMPTS } from "../../lib/prompts";
import { courseScopeFromAuthContext } from "../repositories/scope";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";

// #317 review, #326: same limit/before validation as
// routes/conversations.ts's listConversationMessagesHandler, shared by this
// file's two message-history handlers below (getActiveSectionConversationHandler,
// getSectionConversationHandler) instead of tripling the copy across two
// files. Returns a Response for the (rare) malformed-param case so a caller
// can `if (parsed instanceof Response) return parsed;` and otherwise use
// `parsed` directly as getSectionConversationMessages' opts.
function parseMessagesPageParams(c: Context<AppEnv>): { limit?: number; before?: number } | Response {
  const limitParam = c.req.query("limit");
  let limit: number | undefined;
  if (limitParam !== undefined) {
    const parsed = Number(limitParam);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
      return c.json({ error: "limit must be an integer between 1 and 500" }, 400);
    }
    limit = parsed;
  }
  const beforeParam = c.req.query("before");
  let before: number | undefined;
  if (beforeParam !== undefined) {
    const parsed = Number(beforeParam);
    if (!Number.isInteger(parsed)) {
      return c.json({ error: "before must be an integer seq value" }, 400);
    }
    before = parsed;
  }
  return { limit, before };
}

/* --------------------------------------------------------------------------
   Section-conversation routes (#27).

   Separate from routes/conversations.ts (tutor conversations, PR #212) --
   different resource, different access rules, and keeping them apart avoids
   two branches rewriting one file.
   -------------------------------------------------------------------------- */

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
      isTeacherTest: !isStudentInCourse(authContext.memberships, courseId!),
      canViewDrafts: authContext.canViewDraftsIn(courseId!),
      // #305: the greeting/title wording is this route's choice to make, not
      // the repository's -- see SECTION_CONVERSATION_PROMPTS in lib/prompts.ts.
      prompts: SECTION_CONVERSATION_PROMPTS,
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

  // #317 review, #351 (requirement 1): the write/model paths (chat.ts,
  // startSectionConversation, restartSectionConversation) all gate on the
  // homework's release state; this read path -- returning `messages`,
  // whose first row is sectionGreeting(section), the full problem statement
  // verbatim -- did not. After an instructor withdraws a homework, POST
  // /api/chat and restart correctly 404; this endpoint kept returning 200
  // with the withdrawn section's content. getSectionPromptContext (already
  // used by chat.ts for the same gate) runs the section->homework join
  // purely for its isUnreleased field here -- notFound(c), not a distinct
  // body, preserving the no-existence-oracle convention this file already
  // states for getSectionConversationHandler below.
  const sectionContext = await getSectionPromptContext(db, scope, sectionId);
  if (sectionContext?.isUnreleased && !authContext.canViewDraftsIn(courseId!)) {
    return notFound(c);
  }

  const pageParams = parseMessagesPageParams(c);
  if (pageParams instanceof Response) return pageParams;
  const messages = await getSectionConversationMessages(db, conversation.id, pageParams);
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
    // #246: grader-tier read (instructor/admin/ta), matching the tier the
    // submissions dashboard that links here already uses (requireGraderOf).
    isGrader: authContext.isGraderOf(courseId!),
  });
  // 404 rather than 403: an instructor's private test conversation should not
  // confirm its own existence to another instructor, and a student probing
  // ids should learn nothing from the status code.
  if (!allowed) return notFound(c);

  // #317 review, #351 (requirement 1): same gate as
  // getActiveSectionConversationHandler above -- see that call site's own
  // doc comment. `conversation.sectionId` is nullable at the schema level
  // (shared with tutor conversations), but every row this route's own query
  // can return is section-kind, so it's always set in practice; guarded
  // rather than asserted so a future schema/data surprise degrades to
  // "content visible" (today's status quo) rather than a crash.
  if (conversation.sectionId) {
    const sectionContext = await getSectionPromptContext(db, scope, conversation.sectionId);
    if (sectionContext?.isUnreleased && !authContext.canViewDraftsIn(courseId!)) {
      return notFound(c);
    }
  }

  const pageParams = parseMessagesPageParams(c);
  if (pageParams instanceof Response) return pageParams;
  const messages = await getSectionConversationMessages(db, conversation.id, pageParams);
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
      authContext.canViewDraftsIn(courseId!),
      // #305: see startSectionConversationHandler above -- a restart's fresh
      // greeting/title comes from the same caller-chosen wording.
      SECTION_CONVERSATION_PROMPTS,
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
