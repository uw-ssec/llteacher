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
} from "../repositories/sectionConversations";
import { SubmissionGradedError } from "../repositories/submissions";
import { getOrgScopesForUser } from "../repositories/users";
import { courseScopeFromAuthContext } from "../repositories/scope";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";

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
      // #27: an instructor working a section is testing their own prompt,
      // not doing the assignment. Recorded now rather than derived later --
      // see the isTeacherTest column comment.
      isTeacherTest: authContext.isInstructorOf(courseId!),
    });
    return c.json(created, 201);
  } catch (err) {
    if (err instanceof SectionConversationExistsError) {
      // 409, not 400: the request is well-formed and the caller is allowed,
      // the resource just already exists. The client's move is to GET it.
      return c.json({ error: err.message }, 409);
    }
    // startSectionConversation's remaining throws are all "you named
    // something that isn't yours or isn't there" (non-member owner, section
    // outside the course, non-interactive section). Uniform 404 so a
    // caller can't probe which sections exist in courses they can see.
    return c.json({ error: "Section not found" }, 404);
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
  // Restarting voids a submission, which is an org-scoped write. Same
  // single-org-per-user assumption submitSectionHandler already makes;
  // restartSectionConversation's own ownership check is what actually
  // narrows this to the right conversation.
  const orgScopes = await getOrgScopesForUser(db, authContext.session.userId);
  const orgScope = orgScopes[0];
  if (!orgScope) return c.json({ error: "No organization membership found" }, 403);

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
    return notFound(c);
  }
}
