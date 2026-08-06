import { and, eq, isNull, or } from "drizzle-orm";
import type { Db } from "../../db/client";
import { submissions, grades, conversations, courses, courseMemberships, homeworks, users } from "../../db/schema";
import type { OrgScope, CourseScope } from "./scope";
import type { IdentityCipher } from "../../lib/crypto/identity-cipher";

export async function createSubmission(db: Db, scope: OrgScope, conversationId: string) {
  // The conversation isn't guaranteed to belong to `scope`'s org just
  // because the caller says so -- verify via the real parent chain
  // (conversation -> course -> org) before writing the denormalized
  // organization_id, or a caller-supplied conversationId from a different
  // org gets mislabeled into this org's data. Also reject a soft-deleted or
  // `tutor`-kind conversation (#140) -- a submission is only representable
  // against a live `section` conversation; without this, a submission
  // against a deleted or free-standing tutor chat is currently insertable.
  // Not-found throw below is plain Error, not yet mapped to a typed 404 --
  // tracked in #141, to land when #22 wires a real route to this function.
  const [owned] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .innerJoin(courses, eq(conversations.courseId, courses.id))
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(courses.organizationId, scope),
        eq(conversations.isDeleted, false),
        eq(conversations.kind, "section"),
      ),
    );
  if (!owned) {
    throw new Error("Conversation not found in this org scope");
  }

  const [created] = await db
    .insert(submissions)
    .values({ conversationId, organizationId: scope })
    .returning();
  return created;
}

export async function submitSection(
  db: Db,
  scope: OrgScope,
  conversationId: string,
  requesterId: string,
): Promise<{ id: string; conversationId: string; submittedAt: Date; isResubmission: boolean }> {
  // Closes the ownership gap noted for conversations.ts's
  // softDeleteConversation/appendMessage (#134): this check is scoped to a
  // single route (the only one #22 adds), so it's inlined here rather than
  // widening every repository function's signature.
  const [owned] = await db
    .select({ id: conversations.id, ownerUserId: conversations.ownerUserId })
    .from(conversations)
    .innerJoin(courses, eq(conversations.courseId, courses.id))
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(courses.organizationId, scope),
        eq(conversations.isDeleted, false),
        eq(conversations.kind, "section"),
      ),
    );
  // Two distinct messages, not one combined check -- found in review: a
  // single message conflated "doesn't exist / soft-deleted / wrong kind"
  // with "exists but wrong owner," leaving the route layer (Task 17) no way
  // to tell them apart if it ever needs to (today it deliberately maps both
  // to a uniform 403 to avoid leaking conversation existence to a non-owner,
  // but that's a route-layer choice, not something the repository should
  // force by only offering one indistinguishable message).
  if (!owned) {
    throw new Error("Conversation not found or not accessible");
  }
  if (owned.ownerUserId !== requesterId) {
    throw new Error("Conversation is not owned by requester");
  }

  const existing = await getSubmissionByConversation(db, scope, conversationId);
  if (existing) {
    const [updated] = await db
      .update(submissions)
      .set({ submittedAt: new Date() })
      .where(eq(submissions.id, existing.id))
      .returning();
    return { id: updated!.id, conversationId, submittedAt: updated!.submittedAt, isResubmission: true };
  }

  const created = await createSubmission(db, scope, conversationId);
  return { id: created.id, conversationId, submittedAt: created.submittedAt, isResubmission: false };
}

export async function getSubmissionByConversation(db: Db, scope: OrgScope, conversationId: string) {
  const [found] = await db
    .select()
    .from(submissions)
    .where(and(eq(submissions.conversationId, conversationId), eq(submissions.organizationId, scope)));
  return found;
}

export async function recordGrade(
  db: Db,
  scope: OrgScope,
  input: {
    submissionId: string;
    gradedByAi: boolean;
    graderMembershipId?: string;
    score?: number;
    rubric?: unknown;
    feedback?: string;
  },
) {
  // Not-found/invalid-grader throws below are plain Error, not yet mapped
  // to a typed 404 -- tracked in #141, to land when #75 wires a real route.
  const [submission] = await db
    .select({ id: submissions.id })
    .from(submissions)
    .where(and(eq(submissions.id, input.submissionId), eq(submissions.organizationId, scope)));
  if (!submission) {
    throw new Error("Submission not found in this org scope");
  }

  if (input.graderMembershipId) {
    // A membership id is just a UUID from the caller -- confirm it's
    // actually a membership of the course this submission's conversation
    // belongs to, not some other course's (or org's) grader; that it's not
    // dropped (#139 -- matches listMembershipsForUser and
    // createConversation's owner check); and that it's instructor/admin,
    // matching AuthContext.isInstructorOf's own role set (#140) -- a
    // student membership shouldn't pass as a grader. "Which caller may
    // submit a grade for which course" is still the route layer's job per
    // ARCHITECTURE.md's documented split; this is a narrower, repository-
    // level check that the membership being *cited as* the grader is
    // actually capable of grading, independent of who's calling.
    const [validGrader] = await db
      .select({ id: courseMemberships.id })
      .from(courseMemberships)
      .innerJoin(conversations, eq(conversations.courseId, courseMemberships.courseId))
      .innerJoin(submissions, eq(submissions.conversationId, conversations.id))
      .where(
        and(
          eq(courseMemberships.id, input.graderMembershipId),
          eq(submissions.id, input.submissionId),
          isNull(courseMemberships.droppedAt),
          or(eq(courseMemberships.role, "instructor"), eq(courseMemberships.role, "admin")),
        ),
      );
    if (!validGrader) {
      throw new Error("Grader membership does not belong to the submission's course");
    }
  }

  const [created] = await db
    .insert(grades)
    .values({ organizationId: scope, ...input })
    .returning();
  return created;
}

export interface SubmissionCell {
  sectionId: string;
  status: "missing" | "in_progress" | "submitted";
  conversationCount: number;
  lastActivityAt: string | null;
  hasDeletedConversation: boolean;
}

export type ParticipationStatus = "no_interaction" | "partial" | "active";

export interface StudentSubmissionRow {
  studentId: string;
  displayName: string;
  email: string;
  sections: SubmissionCell[];
  totalConversations: number;
  submissionCount: number;
  participationStatus: ParticipationStatus;
  lastActivityAt: string | null;
}

export interface HomeworkSubmissionsMatrix {
  homeworkId: string;
  homeworkTitle: string;
  homeworkDueDate: string;
  sectionHeaders: { id: string; order: number; title: string }[];
  students: StudentSubmissionRow[];
  aggregateStats: {
    totalStudents: number; activeStudents: number; inactiveStudents: number;
    totalSubmissions: number; submissionRate: number;
  };
}

/** Single-pass aggregation: roster, sections, conversations (incl.
 *  soft-deleted, for badge display), and submissions are each fetched once
 *  (4 queries total regardless of roster/section size) and joined in
 *  memory -- avoids the N+1 the Django reference had (issue #23's own
 *  framework note). Names/emails decrypted here, server-side only; nothing
 *  upstream of this function ever sees ciphertext. */
export async function getHomeworkSubmissionsMatrix(
  db: Db,
  scope: CourseScope,
  cipher: IdentityCipher,
  homeworkId: string,
): Promise<HomeworkSubmissionsMatrix | null> {
  const homework = await db.query.homeworks.findFirst({
    where: and(eq(homeworks.id, homeworkId), eq(homeworks.courseId, scope)),
    with: { sections: true },
  });
  if (!homework) return null;

  // Plain select+join, not db.query.courseMemberships.findMany({with:{user:true}}):
  // Drizzle's relational query builder (this installed version) resolves a
  // nested `with` via `left join lateral (select json_build_array(...))`,
  // which forces Postgres to serialize each joined column -- including
  // users.email/displayName's `bytea` -- through JSON. Postgres renders
  // bytea as its hex-text form inside that JSON array, so node-postgres's
  // JSON parser hands the customType's fromDriver a plain string instead of
  // a Buffer; `new Uint8Array(aString)` (encrypted.ts's fromDriver) silently
  // returns a *0-length* array rather than throwing, so every decrypt in
  // this function failed with "Ciphertext shorter than envelope header" --
  // caught by running this against real Postgres, not by reading the code.
  // A flat select+join keeps every column a top-level SQL result column, so
  // node-postgres's normal bytea type parser (a real Buffer) runs and
  // fromDriver decodes correctly -- still one query, no N+1.
  const roster = await db
    .select({
      membershipId: courseMemberships.id,
      userId: courseMemberships.userId,
      email: users.email,
      displayName: users.displayName,
    })
    .from(courseMemberships)
    .innerJoin(users, eq(courseMemberships.userId, users.id))
    .where(and(eq(courseMemberships.courseId, scope), eq(courseMemberships.role, "student"), isNull(courseMemberships.droppedAt)));

  const sectionIds = homework.sections.map((s) => s.id);
  const allConversations = sectionIds.length
    ? await db.query.conversations.findMany({
        where: (c, { inArray }) => inArray(c.sectionId, sectionIds),
      })
    : [];
  const conversationIds = allConversations.map((c) => c.id);
  const allSubmissions = conversationIds.length
    ? await db.query.submissions.findMany({ where: (s, { inArray }) => inArray(s.conversationId, conversationIds) })
    : [];
  const submittedConversationIds = new Set(allSubmissions.map((s) => s.conversationId));

  const students: StudentSubmissionRow[] = [];
  for (const membership of roster) {
    const displayName = membership.displayName ? await cipher.decryptString(membership.displayName) : "";
    const email = await cipher.decryptString(membership.email);

    const cells: SubmissionCell[] = [];
    let totalConversations = 0;
    let submissionCount = 0;
    // Student-level "latest activity across every section" -- distinct from
    // each cell's OWN lastActivityAt below. An earlier draft of this
    // function used one shared variable for both, which meant a later
    // section's cell incorrectly inherited an earlier section's activity
    // timestamp (the cumulative max-so-far, not that section's own).
    let studentLastActivityAt: Date | null = null;

    for (const section of [...homework.sections].sort((a, b) => a.order - b.order)) {
      const convosForCell = allConversations.filter((c) => c.sectionId === section.id && c.ownerUserId === membership.userId);
      const activeConvo = convosForCell.find((c) => !c.isDeleted);
      const hasDeleted = convosForCell.some((c) => c.isDeleted);
      const submitted = convosForCell.some((c) => submittedConversationIds.has(c.id));

      totalConversations += convosForCell.length;
      if (submitted) submissionCount++;

      let cellLastActivityAt: Date | null = null;
      for (const c of convosForCell) {
        if (!cellLastActivityAt || c.updatedAt > cellLastActivityAt) cellLastActivityAt = c.updatedAt;
        if (!studentLastActivityAt || c.updatedAt > studentLastActivityAt) studentLastActivityAt = c.updatedAt;
      }

      cells.push({
        sectionId: section.id,
        status: submitted ? "submitted" : activeConvo ? "in_progress" : "missing",
        conversationCount: convosForCell.length,
        lastActivityAt: cellLastActivityAt?.toISOString() ?? null,
        hasDeletedConversation: hasDeleted,
      });
    }

    const participationStatus: ParticipationStatus =
      totalConversations === 0 ? "no_interaction" : submissionCount > 0 ? "active" : "partial";

    students.push({
      studentId: membership.userId, displayName, email, sections: cells,
      totalConversations, submissionCount, participationStatus,
      lastActivityAt: studentLastActivityAt?.toISOString() ?? null,
    });
  }

  students.sort((a, b) => {
    if (!a.lastActivityAt) return 1;
    if (!b.lastActivityAt) return -1;
    return b.lastActivityAt.localeCompare(a.lastActivityAt);
  });

  const activeStudents = students.filter((s) => s.participationStatus !== "no_interaction").length;
  return {
    homeworkId: homework.id,
    homeworkTitle: homework.title,
    homeworkDueDate: homework.dueDate.toISOString(),
    sectionHeaders: homework.sections.map((s) => ({ id: s.id, order: s.order, title: s.title })).sort((a, b) => a.order - b.order),
    students,
    aggregateStats: {
      totalStudents: students.length,
      activeStudents,
      inactiveStudents: students.length - activeStudents,
      totalSubmissions: students.reduce((sum, s) => sum + s.submissionCount, 0),
      submissionRate: students.length ? Math.round((activeStudents / students.length) * 100) : 0,
    },
  };
}
