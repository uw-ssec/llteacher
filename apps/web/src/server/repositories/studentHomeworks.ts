import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../../db/client";
import { conversations, submissions, courseMemberships } from "../../db/schema";
import { deriveHomeworkStatus } from "./homeworks";

export type SectionStatusType = "not_started" | "in_progress" | "in_progress_overdue" | "submitted" | "overdue";

export function deriveSectionStatus(input: {
  dueDate: Date;
  hasActiveConversation: boolean;
  hasSubmission: boolean;
}): SectionStatusType {
  const overdue = input.dueDate.getTime() < Date.now();
  if (input.hasSubmission) return "submitted";
  if (input.hasActiveConversation) return overdue ? "in_progress_overdue" : "in_progress";
  return overdue ? "overdue" : "not_started";
}

export interface StudentSectionProgress {
  id: string;
  title: string;
  order: number;
  status: SectionStatusType;
  conversationId: string | null;
}

export interface StudentHomeworkSummary {
  id: string;
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
    with: { sections: true },
  });

  const visibleHomeworks = allHomeworks.filter((hw) => {
    const status = deriveHomeworkStatus(hw);
    // #166: "hidden" folds in both is_hidden and a passed expires_at (see
    // deriveHomeworkStatus) -- filtered here the same way draft/scheduled
    // are, by comparing the derived status, never a raw column.
    return status !== "draft" && status !== "scheduled" && status !== "hidden";
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
    ? await db.select({ conversationId: submissions.conversationId }).from(submissions).where(inArray(submissions.conversationId, conversationIds))
    : [];
  const submittedConversationIds = new Set(submittedRows.map((s) => s.conversationId));

  const results: StudentHomeworkSummary[] = [];
  for (const hw of visibleHomeworks) {
    const sectionSummaries: StudentSectionProgress[] = [];
    let completed = 0;
    let inProgress = 0;

    for (const section of hw.sections) {
      const activeConversation = conversationBySectionId.get(section.id) ?? null;
      const hasSubmission = activeConversation ? submittedConversationIds.has(activeConversation.id) : false;

      const sectionStatus = deriveSectionStatus({
        dueDate: hw.dueDate,
        hasActiveConversation: !!activeConversation,
        hasSubmission,
      });
      if (sectionStatus === "submitted") completed++;
      else if (sectionStatus === "in_progress" || sectionStatus === "in_progress_overdue") inProgress++;

      sectionSummaries.push({
        id: section.id, title: section.title, order: section.order, status: sectionStatus,
        conversationId: activeConversation?.id ?? null,
      });
    }
    sectionSummaries.sort((a, b) => a.order - b.order);

    const total = hw.sections.length || 1;
    results.push({
      id: hw.id,
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
