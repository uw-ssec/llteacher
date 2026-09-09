import { type Context } from "hono";
import { z } from "zod";
import { makeDb } from "../../db/client";
import { UUID_RE } from "../utils/uuid";
import { feedbackReasonEnum } from "../../db/schema";
import { getOwnedConversationOrNull } from "../repositories/conversations";
import { isStudentInCourse } from "../repositories/sectionConversations";
import {
  getFlaggableAssistantMessage,
  flagResponse,
  listCourseFeedback,
  ResponseAlreadyFlaggedError,
} from "../repositories/responseFeedback";
import { reserveRateLimitSlot, RATE_LIMIT_MAX_PER_MINUTE, RATE_LIMIT_WINDOW_MS } from "../repositories/rateLimits";
import { MAX_COMMENT_CHARS } from "../../shared/chat-limits";
import { courseScopeFromAuthContext } from "../repositories/scope";
import { loadIdentityCipherKeys } from "../../lib/secrets-loader";
import { IdentityCipher } from "../../lib/crypto/identity-cipher";
import { getOrgScopeForCourse } from "../repositories/organizations";
import { recordTranscriptAccess } from "../../lib/instructor-authz";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";

/* --------------------------------------------------------------------------
   Student feedback flags on AI tutor responses (#90).

   POST /api/conversations/:conversationId/messages/:messageId/feedback
     -- a student flags one of the tutor's own responses in a section
        conversation they own.
   GET  /api/courses/:courseId/instructor/feedback
     -- an instructor/admin/TA (grader tier, #172) reads their course's
        flags for review.

   The POST route deliberately takes no courseId in its URL -- same shape as
   PATCH/DELETE /api/conversations/:id (routes/conversations.ts) -- and
   shares that route's exact ownership primitive, getOwnedConversationOrNull,
   rather than forking a second "does this caller own this conversation"
   check. The GET route reuses the identical grader-tier pattern
   routes/instructor/transcripts.ts already establishes (requireGraderOf at
   registration, canViewDraftsIn's release gate in the handler body) rather
   than forking a second authz helper for this epic's own "org/course
   scoping is non-negotiable" invariant, scoped via
   courseScopeFromAuthContext -- the one sanctioned way to mint a
   CourseScope from request input.

   #90 review, Important #1: the GET route also reuses
   lib/instructor-authz.ts's FERPA audit hook (recordTranscriptAccess,
   widened with a "feedback-list" action) -- this read returns decrypted
   student names and flagged tutor content for a whole course, the same
   class of student-record access the transcript list already audits.
   -------------------------------------------------------------------------- */

const flagResponseSchema = z.object({
  reason: z.enum(feedbackReasonEnum.enumValues),
  comment: z
    .string()
    .trim()
    .max(MAX_COMMENT_CHARS)
    .optional()
    .transform((v) => (v === "" ? undefined : v)),
});

export async function flagResponseHandler(c: Context<AppEnv>) {
  const authContext = c.get("authContext") as AuthContext | undefined;
  if (!authContext) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const conversationId = c.req.param("conversationId");
  const messageId = c.req.param("messageId");
  // #267 convention (routes/conversations.ts): a malformed id 404s rather
  // than reaching a query unvalidated -- same "not found" bucket as an
  // unknown-but-well-formed id, so a probe can't distinguish the two.
  if (!conversationId || !UUID_RE.test(conversationId) || !messageId || !UUID_RE.test(messageId)) {
    return c.json({ error: "Conversation not found" }, 404);
  }

  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }
  const parsed = flagResponseSchema.safeParse(json);
  if (!parsed.success) {
    return c.json(
      { error: "reason is required (incorrect | gave_away_answer | confusing | other); comment, if present, must be 2000 characters or fewer" },
      400,
    );
  }

  const db = makeDb(c.env.DATABASE_URL);

  // Server-hardening audit fix, Minor #1 (Security): this route had no
  // rate limit at all -- a student could spam-flag messages. Reuses the
  // exact same per-user counter/budget #219/#308 already share (routes/
  // chat.ts, routes/conversations.ts) rather than standing up a second
  // one -- a flag is a rare, deliberate action next to chat's per-message
  // volume, so sharing one generous per-minute budget costs a normal user
  // nothing while still bounding a scripted flag-loop.
  const requestCount = await reserveRateLimitSlot(db, authContext.session.userId, new Date(), RATE_LIMIT_WINDOW_MS);
  if (requestCount > RATE_LIMIT_MAX_PER_MINUTE) {
    return c.json(
      { error: "You're sending requests too quickly. Please wait a moment and try again." },
      429,
      { "Retry-After": String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)) },
    );
  }

  // The exact "not found or not owned" primitive PATCH/DELETE
  // /api/conversations/:id already use -- covers a nonexistent
  // conversation, one the caller doesn't own, a soft-deleted one, and one
  // whose course the caller has since left, all as the same 404.
  const conversation = await getOwnedConversationOrNull(
    db,
    conversationId,
    authContext.session.userId,
    authContext.isMemberOf,
  );
  if (!conversation) {
    return c.json({ error: "Conversation not found" }, 404);
  }

  // #90: only an ENROLLED STUDENT may flag -- an instructor/TA teacher-
  // testing a section also owns their own conversation (the ownership
  // check above doesn't distinguish), but a flag is a pilot signal about
  // the tutor's real behavior toward a real student, not a QA note from
  // staff trying out a prompt. Mirrors #237's own rule
  // (isStudentInCourse, repositories/sectionConversations.ts) rather than
  // reinventing it. 404, not 403, matching every other "this isn't yours
  // to act on" response on this route.
  if (!isStudentInCourse(authContext.memberships, conversation.courseId)) {
    return c.json({ error: "Conversation not found" }, 404);
  }

  // Feedback context (section/homework titles, the PR3 transcript-viewer
  // drill-in) only makes sense for a section conversation -- the
  // free-standing "tutor" surface has no section/homework to attach a flag
  // to, and is out of scope for this pilot instrument.
  if (conversation.kind !== "section") {
    return c.json({ error: "Feedback is only available on homework-section conversations" }, 400);
  }

  // Must exist, belong to THIS conversation (not a different or
  // nonexistent one), and actually be the tutor's own turn -- flagging a
  // student's own message or a system row isn't a case this models.
  const message = await getFlaggableAssistantMessage(db, conversationId, messageId);
  if (!message) {
    return c.json({ error: "Message not found" }, 404);
  }

  try {
    const flag = await flagResponse(db, {
      conversationId,
      courseId: conversation.courseId,
      messageId,
      studentId: authContext.session.userId,
      reason: parsed.data.reason,
      comment: parsed.data.comment ?? null,
      responseSnapshot: message.parts,
    });
    return c.json(
      { id: flag.id, reason: flag.reason, comment: flag.comment, flaggedAt: flag.flaggedAt.toISOString() },
      201,
    );
  } catch (err) {
    if (err instanceof ResponseAlreadyFlaggedError) {
      return c.json({ error: err.message, code: "already_flagged" }, 409);
    }
    throw err;
  }
}

export async function listCourseFeedbackHandler(c: Context<AppEnv>) {
  const courseId = c.req.param("courseId");
  const authContext = c.get("authContext") as AuthContext | undefined;

  // Same shape as listInstructorTranscriptsHandler's own guard: the route
  // is also wrapped in requireGraderOf at registration (server/index.ts),
  // and this re-check exists for the same reason that one documents --
  // fail closed for a direct call (e.g. this file's own unit tests), not
  // only behind the guard.
  if (!authContext || !courseId || !authContext.isGraderOf(courseId)) {
    return c.json({ error: "Grader access denied" }, 403);
  }
  const scope = courseScopeFromAuthContext(authContext, courseId);
  if (!scope) return c.json({ error: "Course access denied" }, 403);

  const limitParam = c.req.query("limit");
  let limit = 50;
  if (limitParam !== undefined) {
    const parsedLimit = Number(limitParam);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 200) {
      return c.json({ error: "limit must be an integer between 1 and 200" }, 400);
    }
    limit = parsedLimit;
  }
  const offsetParam = c.req.query("offset");
  let offset = 0;
  if (offsetParam !== undefined) {
    const parsedOffset = Number(offsetParam);
    if (!Number.isInteger(parsedOffset) || parsedOffset < 0) {
      return c.json({ error: "offset must be a non-negative integer" }, 400);
    }
    offset = parsedOffset;
  }

  const db = makeDb(c.env.DATABASE_URL);
  const cipher = new IdentityCipher(await loadIdentityCipherKeys(c.env));

  // #208/#366: the same unreleased-content gate the transcript list applies
  // to its own rows -- a flag's section/homework titles (and, via the
  // dashboard's transcript link, the conversation itself) are unreleased
  // content once the underlying homework is currently draft/scheduled/
  // hidden. A TA without canViewDraftsIn(courseId) must not see the row at
  // all.
  //
  // Server-hardening audit fix, Minor #2 (Security+Scalability+Usability,
  // found independently by all three dimensions): this used to be filtered
  // HERE, on the already-fetched `result.items`, after listCourseFeedback
  // had already computed `total` from the unfiltered query -- so `total`
  // (and the dashboard's own reason-breakdown counts, keyed off it) counted
  // rows a draft-blind TA never actually saw in `items`. Now passed into
  // the repository as `canViewDrafts` instead, so the SQL WHERE clause
  // itself excludes unreleased-homework rows and `total` is exactly
  // `items.length` summed across pages -- see listCourseFeedback's own doc
  // comment (repositories/responseFeedback.ts) for the full mechanism.
  const canSeeUnreleased = authContext.canViewDraftsIn(courseId);
  const result = await listCourseFeedback(db, scope, cipher, { limit, offset, canViewDrafts: canSeeUnreleased });

  // #90 review (Important #1): FERPA -- this read returns decrypted student
  // names plus flagged tutor content for a whole course, the identical
  // class of student-record access listInstructorTranscriptsHandler already
  // audits for its own list read. Reuses that exact hook
  // (lib/instructor-authz.ts's recordTranscriptAccess, widened with a
  // "feedback-list" action) rather than a second audit call site -- see
  // that module's own #90 doc comment. Best-effort/never blocks the
  // response, same tradeoff every other caller of this hook makes.
  const orgScope = await getOrgScopeForCourse(db, courseId);
  await recordTranscriptAccess(db, orgScope, {
    viewerId: authContext.session.userId,
    courseId,
    action: "feedback-list",
  });

  return c.json({
    items: result.items.map((item) => ({
      id: item.id,
      conversationId: item.conversationId,
      messageId: item.messageId,
      studentId: item.studentId,
      studentName: item.studentName,
      reason: item.reason,
      comment: item.comment,
      responseSnapshot: item.responseSnapshot,
      isDeleted: item.isDeleted,
      sectionId: item.sectionId,
      sectionTitle: item.sectionTitle,
      homeworkId: item.homeworkId,
      homeworkTitle: item.homeworkTitle,
      flaggedAt: item.flaggedAt.toISOString(),
    })),
    total: result.total,
    limit,
    offset,
  });
}
