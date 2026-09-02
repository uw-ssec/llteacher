import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import {
  responseFeedback,
  messages,
  conversations,
  sections,
  homeworks,
  users,
} from "../../db/schema";
import type { FeedbackReason } from "../../db/schema";
import type { CourseScope } from "./scope";
import { deriveHomeworkStatus, type HomeworkStatus } from "./homeworks";
import { isUniqueViolation } from "./errors";
import type { IdentityCipher } from "../../lib/crypto/identity-cipher";

/* --------------------------------------------------------------------------
   Student feedback flags on AI tutor responses (#90).

   A pilot-scale instrument, not a moderation system -- see the issue's own
   "keep it small" framing, restated on db/schema/runtime.ts's
   responseFeedback table (the schema decisions, incl. why messageId is
   nullable/SET NULL and why responseSnapshot exists at all, live there
   rather than being repeated here).

   This module owns two things: writing a flag (flagResponse, plus the
   "which message may this student even flag" lookup getFlaggableMessage)
   and reading a course's flags for the instructor dashboard
   (listCourseFeedback) -- deliberately NOT the transcript context around a
   flag, which is PR3's instructor transcript viewer's job
   (repositories/sectionConversations.ts's getInstructorTranscriptDetail /
   getSectionConversationMessagesFromStart). The dashboard links into that
   existing surface by conversationId rather than this module re-fetching or
   re-rendering a transcript a second way.
   -------------------------------------------------------------------------- */

/** Thrown by flagResponse when the (messageId, studentId) unique index
 *  (response_feedback_message_student_uq) rejects a second flag on the same
 *  message by the same student -- including two concurrent requests racing
 *  each other, which an application-level "check then insert" could not
 *  close on its own (the issue's own explicit requirement: enforce this
 *  with a DB constraint, not just an app check). Named/typed the same way
 *  every other repository-level refusal in this codebase is (see
 *  SectionConversationExistsError, PromptTemplateConflictError) so the
 *  route layer can catch exactly this and nothing else. */
export class ResponseAlreadyFlaggedError extends Error {
  constructor() {
    super("You've already flagged this response");
    this.name = "ResponseAlreadyFlaggedError";
  }
}

/** The one assistant message a POST may flag: must belong to the given
 *  conversation (a caller-supplied messageId from a DIFFERENT conversation,
 *  or one that plain doesn't exist, both resolve to null here) and must
 *  actually be an assistant turn -- flagging the student's own message, or a
 *  system row, is not a case this feature models. Returns the row's
 *  `parts` verbatim so the caller can snapshot exactly what the message
 *  said at flag time (see responseSnapshot's own doc comment on the table). */
export async function getFlaggableAssistantMessage(
  db: Db,
  conversationId: string,
  messageId: string,
): Promise<{ id: string; parts: unknown } | null> {
  const [row] = await db
    .select({ id: messages.id, parts: messages.parts })
    .from(messages)
    .where(
      and(
        eq(messages.id, messageId),
        eq(messages.conversationId, conversationId),
        eq(messages.role, "assistant"),
      ),
    );
  return row ?? null;
}

export interface FlagResponseInput {
  conversationId: string;
  messageId: string;
  studentId: string;
  reason: FeedbackReason;
  comment: string | null;
  /** The message's `parts` at flag time -- see getFlaggableAssistantMessage. */
  responseSnapshot: unknown;
}

/** Inserts one flag. Throws ResponseAlreadyFlaggedError on the unique-index
 *  violation instead of letting the raw Postgres error propagate -- matches
 *  every other unique-index translation in this codebase (see
 *  isUniqueViolation's own doc comment in repositories/errors.ts). */
export async function flagResponse(
  db: Db,
  input: FlagResponseInput,
): Promise<{ id: string; reason: FeedbackReason; comment: string | null; flaggedAt: Date }> {
  try {
    const [row] = await db
      .insert(responseFeedback)
      .values({
        conversationId: input.conversationId,
        messageId: input.messageId,
        studentId: input.studentId,
        reason: input.reason,
        comment: input.comment,
        responseSnapshot: input.responseSnapshot,
      })
      .returning({
        id: responseFeedback.id,
        reason: responseFeedback.reason,
        comment: responseFeedback.comment,
        flaggedAt: responseFeedback.flaggedAt,
      });
    return row!;
  } catch (err) {
    if (isUniqueViolation(err, "response_feedback_message_student_uq")) {
      throw new ResponseAlreadyFlaggedError();
    }
    throw err;
  }
}

export interface CourseFeedbackListItem {
  id: string;
  conversationId: string;
  messageId: string | null;
  studentId: string;
  /** Decrypted server-side, same convention (and same "" fallback for no
   *  displayName) as InstructorTranscriptListItem.studentName. */
  studentName: string;
  reason: FeedbackReason;
  comment: string | null;
  /** The exact `parts` stored at flag time -- see the table's own doc
   *  comment for why this is never re-read from `messages`. */
  responseSnapshot: unknown;
  sectionId: string;
  sectionTitle: string;
  homeworkId: string;
  homeworkTitle: string;
  /** Same "unreleased content" gate the transcript list applies to its own
   *  rows (#208/#366) -- computed here rather than exposed as raw columns,
   *  matching that list's own convention. The route filters on this for a
   *  grader without canViewDraftsIn. */
  homeworkStatus: HomeworkStatus;
  flaggedAt: Date;
}

export interface CourseFeedbackListResult {
  items: CourseFeedbackListItem[];
  total: number;
}

const DEFAULT_FEEDBACK_LIST_PAGE_SIZE = 50;

/** Every flag raised in this course, newest first, limit/offset-paginated
 *  the same way listInstructorTranscripts is (this dashboard's own "Testing
 *  Strategy" requirement is a strict org/course filter, not an infinite-
 *  scroll shape). Scoped by `scope` (a CourseScope, minted only via
 *  courseScopeFromAuthContext -- see scope.ts) joining
 *  response_feedback -> conversations.course_id, the same course-scoping
 *  path every other conversation-adjacent table in this schema uses
 *  (conversations itself carries no organization_id, by design). */
export async function listCourseFeedback(
  db: Db,
  scope: CourseScope,
  cipher: IdentityCipher,
  opts: { limit?: number; offset?: number } = {},
): Promise<CourseFeedbackListResult> {
  const limit = opts.limit ?? DEFAULT_FEEDBACK_LIST_PAGE_SIZE;
  const offset = opts.offset ?? 0;

  const where = eq(conversations.courseId, scope);

  const [totalRow] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(responseFeedback)
    .innerJoin(conversations, eq(responseFeedback.conversationId, conversations.id))
    .where(where);
  const total = totalRow?.total ?? 0;

  // Flat select+join, not db.query...with() -- same reason
  // listInstructorTranscripts' own comment gives: the relational query
  // builder resolves a nested `with` via a lateral JSON join, which mangles
  // an encrypted bytea column (users.displayName) on its way through.
  const rows = await db
    .select({
      id: responseFeedback.id,
      conversationId: responseFeedback.conversationId,
      messageId: responseFeedback.messageId,
      studentId: responseFeedback.studentId,
      studentDisplayName: users.displayName,
      reason: responseFeedback.reason,
      comment: responseFeedback.comment,
      responseSnapshot: responseFeedback.responseSnapshot,
      flaggedAt: responseFeedback.flaggedAt,
      sectionId: sections.id,
      sectionTitle: sections.title,
      homeworkId: homeworks.id,
      homeworkTitle: homeworks.title,
      homeworkDueDate: homeworks.dueDate,
      homeworkPublishedAt: homeworks.publishedAt,
      homeworkReleasedAt: homeworks.releasedAt,
      homeworkIsHidden: homeworks.isHidden,
      homeworkExpiresAt: homeworks.expiresAt,
    })
    .from(responseFeedback)
    .innerJoin(conversations, eq(responseFeedback.conversationId, conversations.id))
    .innerJoin(users, eq(responseFeedback.studentId, users.id))
    // #90's conversations are always "section" kind in practice (only a
    // section conversation's assistant turns are reachable via
    // getFlaggableAssistantMessage's route-level check today, since the
    // client affordance only ever renders on the homework-section chat --
    // see the client-side task report for that scope note), but this join
    // is written as INNER on sectionId being present rather than assuming
    // it: a tutor-kind conversation's sectionId is NULL by the schema's own
    // kind/section-nullability CHECK, and such a row would simply be
    // excluded here rather than crash the join.
    .innerJoin(sections, eq(conversations.sectionId, sections.id))
    .innerJoin(homeworks, eq(sections.homeworkId, homeworks.id))
    .where(where)
    .orderBy(desc(responseFeedback.flaggedAt))
    .limit(limit)
    .offset(offset);

  const items: CourseFeedbackListItem[] = [];
  for (const row of rows) {
    items.push({
      id: row.id,
      conversationId: row.conversationId,
      messageId: row.messageId,
      studentId: row.studentId,
      studentName: row.studentDisplayName ? await cipher.decryptString(row.studentDisplayName) : "",
      reason: row.reason,
      comment: row.comment,
      responseSnapshot: row.responseSnapshot,
      sectionId: row.sectionId,
      sectionTitle: row.sectionTitle,
      homeworkId: row.homeworkId,
      homeworkTitle: row.homeworkTitle,
      homeworkStatus: deriveHomeworkStatus({
        dueDate: row.homeworkDueDate,
        publishedAt: row.homeworkPublishedAt,
        releasedAt: row.homeworkReleasedAt,
        isHidden: row.homeworkIsHidden,
        expiresAt: row.homeworkExpiresAt,
      }),
      flaggedAt: row.flaggedAt,
    });
  }

  return { items, total };
}
