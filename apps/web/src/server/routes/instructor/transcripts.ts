import { type Context } from "hono";
import { makeDb } from "../../../db/client";
import { UUID_RE } from "../../utils/uuid";
import {
  listInstructorTranscripts,
  getInstructorTranscriptDetail,
  getSectionConversationMessagesFromStart,
  canReadSectionConversation,
  DEFAULT_TRANSCRIPT_LIST_PAGE_SIZE,
} from "../../repositories/sectionConversations";
import { isUnreleased } from "../../repositories/homeworks";
import { getOrgScopeForCourse } from "../../repositories/organizations";
import { courseScopeFromAuthContext } from "../../repositories/scope";
import { loadIdentityCipherKeys } from "../../../lib/secrets-loader";
import { IdentityCipher } from "../../../lib/crypto/identity-cipher";
import { canReadCourseTranscripts, recordTranscriptAccess } from "../../../lib/instructor-authz";
import type { AuthContext } from "../../middleware/roles";
import type { AppEnv } from "../../context";

/* --------------------------------------------------------------------------
   Instructor transcript viewer routes (#29).

   GET /api/courses/:courseId/instructor/transcripts        -- list
   GET /api/courses/:courseId/instructor/transcripts/:conversationId -- detail

   Both handlers re-check authorization themselves (canReadCourseTranscripts)
   even though server/index.ts also wraps them in requireGraderOf() --
   matches every other guarded handler in this codebase (see
   getHomeworkSubmissionsHandler's own comment on why: a direct call to the
   handler, e.g. from this file's own unit tests, must still fail closed).

   Deliberately thin: all of the actual query/access logic lives in
   repositories/sectionConversations.ts (list/detail queries,
   canReadSectionConversation) and lib/instructor-authz.ts (the course-level
   gate, the audit hook) -- this file only translates HTTP <-> those calls,
   the same split every other routes/*.ts file in this app follows.
   -------------------------------------------------------------------------- */

/** A caller-controlled uuid path/query param that doesn't match uuid shape
 *  reaches Postgres unvalidated otherwise (SEC-003's own class of bug --
 *  see routes/submissions.ts's getHomeworkSubmissionsHandler for the
 *  precedent this mirrors). Checked before any query runs. */
function isValidUuidParam(value: string | undefined): value is string {
  return value !== undefined && UUID_RE.test(value);
}

export async function listInstructorTranscriptsHandler(c: Context<AppEnv>) {
  const courseId = c.req.param("courseId");
  const authContext = c.get("authContext") as AuthContext | undefined;

  if (!authContext || !courseId || !canReadCourseTranscripts(authContext, courseId)) {
    return c.json({ error: "Grader access denied" }, 403);
  }
  const scope = courseScopeFromAuthContext(authContext, courseId);
  if (!scope) return c.json({ error: "Course access denied" }, 403);

  const sectionIdParam = c.req.query("sectionId");
  if (sectionIdParam !== undefined && !UUID_RE.test(sectionIdParam)) {
    return c.json({ error: "sectionId must be a valid uuid" }, 400);
  }
  const studentIdParam = c.req.query("studentId");
  if (studentIdParam !== undefined && !UUID_RE.test(studentIdParam)) {
    return c.json({ error: "studentId must be a valid uuid" }, 400);
  }

  const limitParam = c.req.query("limit");
  let limit = DEFAULT_TRANSCRIPT_LIST_PAGE_SIZE;
  if (limitParam !== undefined) {
    const parsed = Number(limitParam);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
      return c.json({ error: "limit must be an integer between 1 and 200" }, 400);
    }
    limit = parsed;
  }
  const offsetParam = c.req.query("offset");
  let offset = 0;
  if (offsetParam !== undefined) {
    const parsed = Number(offsetParam);
    if (!Number.isInteger(parsed) || parsed < 0) {
      return c.json({ error: "offset must be a non-negative integer" }, 400);
    }
    offset = parsed;
  }

  const db = makeDb(c.env.DATABASE_URL);
  const cipher = new IdentityCipher(await loadIdentityCipherKeys(c.env));
  const result = await listInstructorTranscripts(db, scope, cipher, authContext.session.userId, {
    sectionId: sectionIdParam,
    studentId: studentIdParam,
    limit,
    offset,
  });

  // #208/#366 merge: a transcript's own content (greeting + replay, built
  // from the section as it stood at conversation-start time) is unreleased
  // content once the underlying homework is currently draft/scheduled/
  // hidden -- same rule listHomeworksHandler already applies to a homework's
  // mere title. A grader without canViewDraftsIn(courseId) (the default TA
  // posture) must not see the row at all. Filtered post-query, matching
  // listHomeworksHandler's own precedent (routes/homeworks.ts) rather than
  // inventing a SQL-predicate version of deriveHomeworkStatus's multi-column
  // logic -- `total`/pagination stay keyed to the unfiltered page, same
  // accepted tradeoff that precedent already makes.
  const canSeeUnreleased = authContext.canViewDraftsIn(courseId);
  const visibleItems = canSeeUnreleased
    ? result.items
    : result.items.filter((item) => !isUnreleased(item.homeworkStatus));

  // FERPA audit -- best-effort, never blocks the response (see
  // recordTranscriptAccess's own doc comment for why this is a real write,
  // not the no-op the issue's own text describes).
  const orgScope = await getOrgScopeForCourse(db, courseId);
  await recordTranscriptAccess(db, orgScope, {
    viewerId: authContext.session.userId,
    courseId,
    action: "list",
  });

  return c.json({
    items: visibleItems.map((item) => ({
      conversationId: item.conversationId,
      studentId: item.studentId,
      studentName: item.studentName,
      sectionId: item.sectionId,
      sectionTitle: item.sectionTitle,
      homeworkId: item.homeworkId,
      homeworkTitle: item.homeworkTitle,
      isTeacherTest: item.isTeacherTest,
      isDeleted: item.isDeleted,
      messageCount: item.messageCount,
      lastMessageSnippet: item.lastMessageSnippet,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
    })),
    total: result.total,
    limit,
    offset,
  });
}

/** Full transcript reads are one-shot (an instructor reading a student's
 *  record wants the whole thing, not an incrementally-scrolled live chat)
 *  but still bounded -- an unbounded query is the same "OOM on a
 *  pathological conversation" risk the list endpoint's own pagination
 *  exists to avoid, just at a different granularity. Far above
 *  DEFAULT_MESSAGES_PAGE_SIZE (200, tuned for a live chat's per-scroll
 *  fetch): a single homework section's conversation running past a
 *  thousand messages is not a case this route optimizes for, it's a case
 *  this route refuses to let take the request down.
 *
 *  Fetched via getSectionConversationMessagesFromStart (#29 review), not
 *  getSectionConversationMessages -- the latter always returns the TAIL
 *  page (most-recent-N), which for a conversation over this limit would
 *  silently show the instructor the wrong end of the transcript.
 *  `hasMore` (mirrors ConversationView's own hasMoreHistory prop) tells
 *  the truth about a transcript this large instead of silently truncating
 *  it -- and is now honest about which end got cut. */
const TRANSCRIPT_DETAIL_MESSAGE_LIMIT = 1000;

export async function getInstructorTranscriptHandler(c: Context<AppEnv>) {
  const courseId = c.req.param("courseId");
  const conversationId = c.req.param("conversationId");
  const authContext = c.get("authContext") as AuthContext | undefined;

  if (!authContext || !courseId || !canReadCourseTranscripts(authContext, courseId)) {
    return c.json({ error: "Grader access denied" }, 403);
  }
  const scope = courseScopeFromAuthContext(authContext, courseId);
  if (!scope) return c.json({ error: "Course access denied" }, 403);
  // Same not-found shape whether the id is malformed or genuinely missing --
  // shape must never be an existence oracle (SEC-020/#211, matched here from
  // routes/sectionConversations.ts's own notFound() convention).
  if (!isValidUuidParam(conversationId)) {
    return c.json({ error: "Transcript not found" }, 404);
  }

  const db = makeDb(c.env.DATABASE_URL);
  const cipher = new IdentityCipher(await loadIdentityCipherKeys(c.env));
  const detail = await getInstructorTranscriptDetail(db, scope, cipher, conversationId);
  if (!detail) return c.json({ error: "Transcript not found" }, 404);

  // #246: the exact per-row rule the student-facing detail read already
  // enforces (getSectionConversationHandler) -- reused, not re-derived, so
  // the two routes can never disagree about which conversations a grader
  // may open. 404, not 403: a private teacher-test conversation must not
  // confirm its own existence to another grader.
  const allowed = canReadSectionConversation(
    { ownerUserId: detail.ownerUserId, isTeacherTest: detail.isTeacherTest },
    { userId: authContext.session.userId, isGrader: authContext.isGraderOf(courseId) },
  );
  if (!allowed) return c.json({ error: "Transcript not found" }, 404);

  // #208/#366 merge: see listInstructorTranscriptsHandler's own comment --
  // same release gate, applied to the single-conversation read. 404, not
  // 403, matching this route's existing "shape must never be an existence
  // oracle" convention (the comment above canReadSectionConversation's own
  // check) -- a grader without draft rights gets the same response whether
  // the conversation is missing, another grader's teacher-test, or simply
  // currently unreleased.
  if (!authContext.canViewDraftsIn(courseId) && isUnreleased(detail.homeworkStatus)) {
    return c.json({ error: "Transcript not found" }, 404);
  }

  const messages = await getSectionConversationMessagesFromStart(
    db,
    conversationId,
    TRANSCRIPT_DETAIL_MESSAGE_LIMIT,
  );

  const orgScope = await getOrgScopeForCourse(db, courseId);
  await recordTranscriptAccess(db, orgScope, {
    viewerId: authContext.session.userId,
    courseId,
    conversationId,
    action: "detail",
  });

  return c.json({
    conversation: {
      id: detail.conversationId,
      studentId: detail.ownerUserId,
      studentName: detail.studentName,
      sectionId: detail.sectionId,
      sectionTitle: detail.sectionTitle,
      homeworkId: detail.homeworkId,
      homeworkTitle: detail.homeworkTitle,
      isTeacherTest: detail.isTeacherTest,
      isDeleted: detail.isDeleted,
      deletedAt: detail.deletedAt ? detail.deletedAt.toISOString() : null,
      submission: detail.submission
        ? { id: detail.submission.id, submittedAt: detail.submission.submittedAt.toISOString() }
        : null,
      createdAt: detail.createdAt.toISOString(),
      updatedAt: detail.updatedAt.toISOString(),
    },
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      parts: m.parts,
      createdAt: m.createdAt.toISOString(),
    })),
    hasMore: messages.length === TRANSCRIPT_DETAIL_MESSAGE_LIMIT,
  });
}
