import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../../db/client";
import { conversations, submissions, courseMemberships, sectionAnswers, type SubmissionSource } from "../../db/schema";
import { deriveHomeworkStatus, isUnreleased } from "./homeworks";

export type SectionStatusType = "not_started" | "in_progress" | "in_progress_overdue" | "submitted" | "overdue";

/** #164: hasAnswer is treated identically to hasSubmission -- a
 *  non_interactive section's answer *is* its completion, the same way a
 *  conversation section's submission is. Callers pass hasAnswer: false for
 *  a "conversation"-type section (it can never have an answer row), and
 *  hasActiveConversation/hasSubmission: false for a "non_interactive" one
 *  (it can never have a conversation). */
export function deriveSectionStatus(input: {
  dueDate: Date;
  hasActiveConversation: boolean;
  hasSubmission: boolean;
  hasAnswer: boolean;
}): SectionStatusType {
  const overdue = input.dueDate.getTime() < Date.now();
  if (input.hasSubmission || input.hasAnswer) return "submitted";
  if (input.hasActiveConversation) return overdue ? "in_progress_overdue" : "in_progress";
  return overdue ? "overdue" : "not_started";
}

export interface StudentSectionProgress {
  id: string;
  title: string;
  order: number;
  status: SectionStatusType;
  conversationId: string | null;
  /** #167: for a `submitted` section, whether the student submitted it or
   *  the scheduled overdue sweep did (jobs/autoSubmitOverdue.ts). Null for
   *  every other status, and null for a non_interactive section's answer --
   *  an answer row has no submission and so no provenance.
   *
   *  A separate field rather than a sixth SectionStatusType value: "was it
   *  submitted" and "who submitted it" are independent questions, and
   *  folding them into one union would force every existing consumer of
   *  `status === "submitted"` (the client sidebar, the percentage
   *  arithmetic below) to be rewritten to match two values instead of one,
   *  with a silent under-count for any that were missed. */
  submissionSource: SubmissionSource | null;
}

export interface StudentHomeworkSummary {
  id: string;
  /** #4: the tutor-conversations list surface (apps/web/src/client/hooks/
   *  useTutorConversations.ts) needs a courseId to call GET/POST
   *  /api/conversations?courseId=... -- this endpoint is the only place
   *  the student client currently learns its course context (the client
   *  has no course-switching UI yet), so it rides along on the homework
   *  summary it's already fetching rather than a new endpoint. */
  courseId: string;
  /** #304 (requirement 4): the course's short code (e.g. "STAT 311"), so
   *  the client has a real course label instead of a hardcoded stand-in. */
  courseName: string;
  title: string;
  description: string;
  dueDate: string;
  completedPercentage: number;
  inProgressPercentage: number;
  sections: StudentSectionProgress[];
}

/** Enrollment-scoped: only homeworks belonging to courses the user has a
 *  non-dropped `student` membership in (deliberate improvement over Django,
 *  which showed all homeworks to all students -- see issue #20). Published-
 *  only: filters via the same on-read status derivation as the instructor
 *  route (Phase 1), so a draft/scheduled homework never appears here even
 *  though nothing in this query references publishedAt/releasedAt by name --
 *  it's filtered by comparing deriveHomeworkStatus's result, not a raw
 *  column check, so the two can never drift out of sync. */
export async function getStudentHomeworksForUser(db: Db, userId: string): Promise<StudentHomeworkSummary[]> {
  const memberships = await db.query.courseMemberships.findMany({
    where: and(eq(courseMemberships.userId, userId), eq(courseMemberships.role, "student"), isNull(courseMemberships.droppedAt)),
  });
  const courseIds = memberships.map((m) => m.courseId);
  if (courseIds.length === 0) return [];

  const allHomeworks = await db.query.homeworks.findMany({
    where: (h, { inArray: inArrayOp }) => inArrayOp(h.courseId, courseIds),
    // #304 (requirement 4): course.code rides along here so the client can
    // thread a real courseName instead of deriving course context from the
    // first homework in the list (or, before this fix, not deriving it at
    // all -- App.tsx's breadcrumb/TopNav had "STATS 311" hardcoded as a
    // literal, one character off from the actual seeded course.code).
    with: { sections: true, course: { columns: { code: true } } },
  });

  const visibleHomeworks = allHomeworks.filter((hw) => {
    const status = deriveHomeworkStatus(hw);
    // #166: "hidden" folds in both is_hidden and a passed expires_at (see
    // deriveHomeworkStatus) -- filtered here the same way draft/scheduled
    // are, by comparing the derived status, never a raw column.
    //
    // #197 (#172 re-audit, MNT-020): via isUnreleased, not the literal
    // triple this used to spell out. #172 extracted that constant precisely
    // so release-state gates stop being hand-written -- and then missed this
    // one, the gate protecting students, while its JSDoc claimed to cover
    // "every route". #166 added `hidden` to this vocabulary a milestone ago,
    // so the next status added would have reached the four instructor-facing
    // gates from one edit and left every student still seeing it here.
    return !isUnreleased(status);
  });

  // #158: batch the per-section conversation/submission lookups instead of
  // querying per section inside a per-homework loop (up to ~120 sequential
  // round-trips for 3 published homeworks x 20 sections, each its own HTTP
  // request on neon-http). Mirrors getHomeworkSubmissionsMatrix's fetch-by-
  // inArray-then-join-in-memory pattern: query count is now fixed regardless
  // of homework/section count.
  const allSectionIds = visibleHomeworks.flatMap((hw) => hw.sections.map((s) => s.id));
  const activeConversations = allSectionIds.length
    ? await db
        .select({ id: conversations.id, sectionId: conversations.sectionId })
        .from(conversations)
        .where(and(inArray(conversations.sectionId, allSectionIds), eq(conversations.ownerUserId, userId), eq(conversations.isDeleted, false)))
    : [];
  // At most one active (non-deleted) conversation per (section, user) is the
  // case this app enforces today -- if that ever changes, this map keeps the
  // last row seen rather than the original per-section query's first.
  const conversationBySectionId = new Map(activeConversations.map((c) => [c.sectionId, c]));

  const conversationIds = activeConversations.map((c) => c.id);
  const submittedRows = conversationIds.length
    ? await db
        .select({ conversationId: submissions.conversationId, source: submissions.source })
        .from(submissions)
        .where(inArray(submissions.conversationId, conversationIds))
    : [];
  // #167: conversation -> source, replacing the plain id Set. One map does
  // both jobs -- `has` answers "did this convert to a submission" exactly as
  // the Set did, and `get` answers "who submitted it" off the same row.
  const submissionSourceByConversation = new Map(submittedRows.map((s) => [s.conversationId, s.source]));

  // #164: same batched inArray fetch as conversations/submissions above --
  // one extra query, still a fixed count regardless of section/homework
  // count (preserves the #158 no-N+1 property this function was built to
  // guarantee).
  const answerRows = allSectionIds.length
    ? await db
        .select({ sectionId: sectionAnswers.sectionId })
        .from(sectionAnswers)
        .where(and(inArray(sectionAnswers.sectionId, allSectionIds), eq(sectionAnswers.userId, userId)))
    : [];
  const answeredSectionIds = new Set(answerRows.map((a) => a.sectionId));

  const results: StudentHomeworkSummary[] = [];
  for (const hw of visibleHomeworks) {
    const sectionSummaries: StudentSectionProgress[] = [];
    let completed = 0;
    let inProgress = 0;

    for (const section of hw.sections) {
      const activeConversation = conversationBySectionId.get(section.id) ?? null;
      const hasSubmission = activeConversation ? submissionSourceByConversation.has(activeConversation.id) : false;

      const sectionStatus = deriveSectionStatus({
        dueDate: hw.dueDate,
        hasActiveConversation: !!activeConversation,
        hasSubmission,
        hasAnswer: section.type === "non_interactive" && answeredSectionIds.has(section.id),
      });
      if (sectionStatus === "submitted") completed++;
      else if (sectionStatus === "in_progress" || sectionStatus === "in_progress_overdue") inProgress++;

      sectionSummaries.push({
        id: section.id, title: section.title, order: section.order, status: sectionStatus,
        conversationId: activeConversation?.id ?? null,
        // Only meaningful when a real submission row backs the status --
        // a non_interactive section's answer also derives "submitted", and
        // it has no submission row behind it.
        submissionSource: hasSubmission ? (submissionSourceByConversation.get(activeConversation!.id) ?? null) : null,
      });
    }
    sectionSummaries.sort((a, b) => a.order - b.order);

    const total = hw.sections.length || 1;
    results.push({
      id: hw.id,
      courseId: hw.courseId,
      courseName: hw.course.code,
      title: hw.title,
      description: hw.description,
      dueDate: hw.dueDate.toISOString(),
      completedPercentage: Math.round((completed / total) * 100),
      inProgressPercentage: Math.round((inProgress / total) * 100),
      sections: sectionSummaries,
    });
  }
  return results;
}
