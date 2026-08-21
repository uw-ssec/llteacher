import { and, eq, inArray, isNull, or } from "drizzle-orm";
import type { Db } from "../../db/client";
import { submissions, grades, conversations, courses, courseMemberships, homeworks, sections, users, sectionAnswers } from "../../db/schema";
import type { OrgScope, CourseScope } from "./scope";
import type { IdentityCipher } from "../../lib/crypto/identity-cipher";
import { deriveHomeworkStatus, isHomeworkHidden, type HomeworkStatus } from "./homeworks";

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
    .select({
      id: conversations.id,
      ownerUserId: conversations.ownerUserId,
      sectionId: conversations.sectionId,
    })
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
    .values({
      conversationId,
      organizationId: scope,
      // #128: taken from the row just verified above rather than re-fetched.
      // The composite FK would reject a mismatch either way, but sourcing
      // both from a single read means there is no window in which the two
      // could disagree in the first place. The kind='section' predicate
      // above is what guarantees sectionId is non-null here.
      userId: owned.ownerUserId,
      sectionId: owned.sectionId!,
    })
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
  // #177: joined through to sections/homeworks (via conversations.sectionId)
  // to read isHidden/expiresAt -- same rationale as
  // upsertSectionAnswer/submitWidgetResponse's identical addition.
  const [owned] = await db
    .select({
      id: conversations.id,
      ownerUserId: conversations.ownerUserId,
      isTeacherTest: conversations.isTeacherTest,
      isHidden: homeworks.isHidden,
      expiresAt: homeworks.expiresAt,
    })
    .from(conversations)
    .innerJoin(courses, eq(conversations.courseId, courses.id))
    .innerJoin(sections, eq(conversations.sectionId, sections.id))
    .innerJoin(homeworks, eq(sections.homeworkId, homeworks.id))
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
    throw new ConversationNotSubmittableError();
  }
  if (owned.ownerUserId !== requesterId) {
    throw new NotSubmissionOwnerError();
  }
  if (isHomeworkHidden(owned)) {
    throw new HomeworkClosedError();
  }
  // #27 (Django parity): ConversationService's `can_submit` excludes teacher
  // test conversations -- an instructor trying out their own prompts is not
  // producing a submission, and one appearing in the roster matrix would be
  // counted as student work. Enforced here rather than only in the route
  // because #128's composite FK deliberately does not encode it: a teacher
  // test conversation is a perfectly valid section conversation, it just
  // isn't submittable.
  if (owned.isTeacherTest) {
    throw new TeacherTestNotSubmittableError();
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

/** A restart was refused because the submission has already been graded.
 *
 *  A distinct class rather than another plain Error so the route layer (#27)
 *  can map it to a 409 without string-matching a message.
 *
 *  Defined here rather than in a shared errors module on purpose: PR #212
 *  introduces `repositories/errors.ts` with `TenancyMismatchError`. Creating
 *  that same file from this branch would mean two branches racing to author
 *  one module. Move this class alongside that one once #212 lands. */
/* --------------------------------------------------------------------------
   Typed submit refusals (#251).

   submitSection's refusals were plain Errors, so routes/submissions.ts could
   only catch them with a bare `catch` that also swallowed unexpected
   failures -- a dropped connection was reported to the student as
   "Conversation not found or not accessible" and never reached app.onError's
   log or 503. Same shape #236 fixed in sectionConversations.ts; missed here
   because this file's catch was edited for #242 without the standard being
   applied to it. Caught in review by @KshitijDani.

   Defined in this module rather than a shared errors file: PR #212
   introduces repositories/errors.ts, and sectionConversations.ts already
   imports from here, so a shared module would either race #212 or create a
   cycle. Consolidate once #212 lands.
   -------------------------------------------------------------------------- */

/** Base for every refusal submitSection raises deliberately, so a route can
 *  exclude the unexpected structurally rather than by message. */
export class SubmissionError extends Error {}

/** The conversation is absent, soft-deleted, the wrong kind, or in another
 *  org. Kept distinct from NotSubmissionOwnerError at the repository layer so
 *  the route chooses what to collapse -- it deliberately collapses both. */
export class ConversationNotSubmittableError extends SubmissionError {
  constructor() {
    super("Conversation not found or not accessible");
    this.name = "ConversationNotSubmittableError";
  }
}

export class NotSubmissionOwnerError extends SubmissionError {
  constructor() {
    super("Conversation is not owned by requester");
    this.name = "NotSubmissionOwnerError";
  }
}

/** #166/#177: the homework is hidden or past its expiry. The student had
 *  legitimate access, so naming the reason leaks nothing they did not
 *  already know -- and "not found" would send them looking for a bug. */
export class HomeworkClosedError extends SubmissionError {
  constructor() {
    super("Homework is hidden or expired");
    this.name = "HomeworkClosedError";
  }
}

/** #242: an instructor's own test conversation is not submittable. Typed so
 *  submitSectionHandler can say that plainly instead of folding it into the
 *  uniform "not found or not accessible" 403 -- the caller owns the
 *  conversation, so naming the real reason leaks nothing. */
export class TeacherTestNotSubmittableError extends SubmissionError {
  constructor() {
    super("Teacher test conversations cannot be submitted");
    this.name = "TeacherTestNotSubmittableError";
  }
}

export class SubmissionGradedError extends SubmissionError {
  constructor() {
    super("Submission has already been graded and cannot be restarted");
    this.name = "SubmissionGradedError";
  }
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
    /** #75: a score needs a scale -- grades_score_requires_max_chk rejects
     *  one without the other. Optional here only because a feedback-only
     *  grade (both absent) is a supported case. */
    maxScore?: number;
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
  /** #75: the submission behind a `submitted` cell, so the dashboard can
   *  drill into grading. Null for every other status -- there is nothing to
   *  grade until a student has submitted -- and null for a non_interactive
   *  section, which records an answer rather than a submission.
   *
   *  Surfaced here rather than fetched per cell by the client: the matrix
   *  already reads `submissions` to decide the status, so this is a field
   *  off a row it holds, not another query. */
  submissionId: string | null;
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
  /** #172 audit (SEC-001): surfaced so the route can apply the same
   *  unreleased-content gate the homework detail route applies. Without it
   *  this dashboard leaked a hidden homework's title, due date and section
   *  titles to a TA the instructor denied `can_view_drafts`. */
  homeworkStatus: HomeworkStatus;
  homeworkTitle: string;
  homeworkDueDate: string;
  sectionHeaders: { id: string; order: number; title: string }[];
  students: StudentSubmissionRow[];
  missingSectionWarnings: { sectionId: string; sectionTitle: string; missingStudentCount: number }[];
  aggregateStats: {
    totalStudents: number; activeStudents: number; inactiveStudents: number;
    totalSubmissions: number; submissionRate: number;
  };
}

/** Most-recent-activity-first, nulls (no activity at all) last. #162: both
 *  null must return 0 -- returning 1 for both (a, b) and (b, a), as an
 *  earlier version did, is not a valid ordering (it will not throw, but
 *  leaves the relative order of students with no activity arbitrary and
 *  unstable across runs/engines). Exported so this ordering rule has its
 *  own direct unit test rather than only being exercised indirectly through
 *  getHomeworkSubmissionsMatrix's full aggregation. */
export function compareByLastActivityDesc(a: { lastActivityAt: string | null }, b: { lastActivityAt: string | null }): number {
  if (!a.lastActivityAt && !b.lastActivityAt) return 0;
  if (!a.lastActivityAt) return 1;
  if (!b.lastActivityAt) return -1;
  return b.lastActivityAt.localeCompare(a.lastActivityAt);
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
  // #75: conversation -> submission, so a submitted cell can carry the id
  // the grading panel needs without a second query.
  const submissionIdByConversation = new Map(allSubmissions.map((s) => [s.conversationId, s.id]));

  // #164: non_interactive sections never produce a conversation, so
  // submitted/activeConvo below are always empty/false for them -- fetched
  // the same batched way as conversations/submissions above (one more
  // query, still fixed count regardless of roster/section size).
  const allAnswers = sectionIds.length
    ? await db.select({ sectionId: sectionAnswers.sectionId, userId: sectionAnswers.userId }).from(sectionAnswers).where(inArray(sectionAnswers.sectionId, sectionIds))
    : [];
  const answeredByUserSection = new Set(allAnswers.map((a) => `${a.userId}:${a.sectionId}`));

  const students: StudentSubmissionRow[] = [];
  for (const membership of roster) {
    const displayName = membership.displayName ? await cipher.decryptString(membership.displayName) : "";
    const email = await cipher.decryptString(membership.email);

    const cells: SubmissionCell[] = [];
    let totalConversations = 0;
    let submissionCount = 0;
    // Distinct from totalConversations: also counts a non_interactive
    // section's answer, which is real engagement with no conversation
    // behind it. Used only for the no_interaction/partial/active split
    // below -- totalConversations itself keeps meaning literally "how many
    // conversations," unchanged for any other consumer.
    let totalEngagement = 0;
    // Student-level "latest activity across every section" -- distinct from
    // each cell's OWN lastActivityAt below. An earlier draft of this
    // function used one shared variable for both, which meant a later
    // section's cell incorrectly inherited an earlier section's activity
    // timestamp (the cumulative max-so-far, not that section's own).
    let studentLastActivityAt: Date | null = null;

    for (const section of [...homework.sections].sort((a, b) => a.order - b.order)) {
      if (section.type === "non_interactive") {
        // #164: no conversation ever exists for this section type -- status
        // comes from whether an answer row exists, not from the (always
        // empty) conversation/submission lookups above.
        const answered = answeredByUserSection.has(`${membership.userId}:${section.id}`);
        if (answered) { submissionCount++; totalEngagement++; }
        cells.push({
          sectionId: section.id,
          status: answered ? "submitted" : "missing",
          conversationCount: 0,
          lastActivityAt: null,
          hasDeletedConversation: false,
          // #164: a non_interactive section records a section_answers row,
          // never a submission -- so there is no submission to grade here.
          submissionId: null,
        });
        continue;
      }

      const convosForCell = allConversations.filter((c) => c.sectionId === section.id && c.ownerUserId === membership.userId);
      const activeConvo = convosForCell.find((c) => !c.isDeleted);
      const hasDeleted = convosForCell.some((c) => c.isDeleted);
      const submittedConvo = convosForCell.find((c) => submittedConversationIds.has(c.id));
      const submitted = submittedConvo !== undefined;

      totalConversations += convosForCell.length;
      totalEngagement += convosForCell.length;
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
        submissionId: submittedConvo ? (submissionIdByConversation.get(submittedConvo.id) ?? null) : null,
      });
    }

    const participationStatus: ParticipationStatus =
      totalEngagement === 0 ? "no_interaction" : submissionCount > 0 ? "active" : "partial";

    students.push({
      studentId: membership.userId, displayName, email, sections: cells,
      totalConversations, submissionCount, participationStatus,
      lastActivityAt: studentLastActivityAt?.toISOString() ?? null,
    });
  }

  students.sort(compareByLastActivityDesc);

  // #23: a summary aggregation over each cell's already-computed status --
  // no new query -- surfacing sections most of the roster hasn't touched
  // yet. A section every student has touched is omitted entirely (not
  // returned with count 0), so the client only ever renders real warnings.
  const missingSectionWarnings = homework.sections
    .map((section) => {
      const missingCount = students.filter((s) => s.sections.find((c) => c.sectionId === section.id)?.status === "missing").length;
      return { sectionId: section.id, sectionTitle: section.title, missingStudentCount: missingCount };
    })
    .filter((w) => w.missingStudentCount > 0)
    .sort((a, b) => b.missingStudentCount - a.missingStudentCount);

  // #159: "activeStudents" means any engagement (a conversation exists,
  // participationStatus !== "no_interaction") -- that's what its own name
  // claims, and it's a legitimate distinct concept from "submitted", so
  // it's left as-is. submissionRate specifically means the share who
  // submitted, which activeStudents does NOT track (it also counts
  // "partial": a conversation with zero submissions) -- so it needs its own
  // count rather than reusing activeStudents.
  const activeStudents = students.filter((s) => s.participationStatus !== "no_interaction").length;
  const submittedStudents = students.filter((s) => s.submissionCount > 0).length;
  return {
    homeworkId: homework.id,
    homeworkStatus: deriveHomeworkStatus(homework),
    homeworkTitle: homework.title,
    homeworkDueDate: homework.dueDate.toISOString(),
    sectionHeaders: homework.sections.map((s) => ({ id: s.id, order: s.order, title: s.title })).sort((a, b) => a.order - b.order),
    students,
    missingSectionWarnings,
    aggregateStats: {
      totalStudents: students.length,
      activeStudents,
      inactiveStudents: students.length - activeStudents,
      totalSubmissions: students.reduce((sum, s) => sum + s.submissionCount, 0),
      submissionRate: students.length ? Math.round((submittedStudents / students.length) * 100) : 0,
    },
  };
}
