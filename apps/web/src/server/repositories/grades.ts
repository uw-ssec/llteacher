/* --------------------------------------------------------------------------
   Grading (#75).

   #14 shipped the `grades` table and nothing wrote to it. This is the first
   writer, and the design turns on one rule stated in the schema and enforced
   by the shape of the data rather than by a flag anybody has to remember:

       A grade is IN FORCE only if graded_by_ai = false.

   So an AI draft is inert. There is no approval boolean to forget to check,
   no state machine, and no path by which a draft becomes authoritative
   except a human writing their own row that points back at it via
   `supersedes_grade_id`. "Never auto-finalized" is therefore not a policy the
   UI implements; it is a thing the data cannot express.

   Nothing is ever updated in place. A regrade is a new row, so the history #75
   asks for is preserved by construction rather than by a trigger or an audit
   table -- and "the current grade" is a query (`the newest human row`), not a
   column that can drift.

   STUDENT VISIBILITY IS OFF. No student-facing route reads this table, and
   none should until the instructor-visibility privacy decision (M9) is
   recorded. That is enforced by absence -- there is no read path a student
   role can reach -- which is the only enforcement that cannot be misconfigured.
   -------------------------------------------------------------------------- */

import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import {
  conversations,
  courseMemberships,
  grades,
  submissions,
  users,
} from "../../db/schema";
import type { CourseScope, OrgScope } from "./scope";
import type { IdentityCipher } from "../../lib/crypto/identity-cipher";
import type { GradePayload } from "@llteacher/ui/api";

/** Thrown when the submission is not in the caller's course. Typed rather
 *  than a plain Error so the route can answer 404 instead of the generic 503
 *  -- the gap #141 recorded against recordGrade, now that a real route
 *  exists to answer it. */
export class SubmissionNotInCourseError extends Error {
  constructor() {
    super("Submission not found in this course");
    this.name = "SubmissionNotInCourseError";
  }
}

/** Confirms a submission belongs to the given COURSE, and returns the
 *  student it belongs to.
 *
 *  Course-scoped, not org-scoped, and that is the point: the caller is
 *  authorized on one course, so the query is constrained by the same key
 *  (#174). An org-scoped check would let an instructor of one course grade a
 *  submission from another course in the same organization. */
export async function getSubmissionInCourse(
  db: Db,
  scope: CourseScope,
  submissionId: string,
): Promise<{ submissionId: string; conversationId: string; studentUserId: string } | null> {
  const [row] = await db
    .select({
      submissionId: submissions.id,
      conversationId: submissions.conversationId,
      studentUserId: conversations.ownerUserId,
    })
    .from(submissions)
    .innerJoin(conversations, eq(submissions.conversationId, conversations.id))
    .where(and(eq(submissions.id, submissionId), eq(conversations.courseId, scope)));
  return row ?? null;
}

/** Every grade on a submission, newest first, with the current one marked.
 *
 *  History is returned in full rather than just the latest: a regrade is a
 *  dispute-relevant fact, and an instructor looking at a changed score needs
 *  to see what it changed from and who changed it. */
export async function listGradesForSubmission(
  db: Db,
  scope: CourseScope,
  submissionId: string,
  cipher: IdentityCipher,
): Promise<GradePayload[]> {
  const found = await getSubmissionInCourse(db, scope, submissionId);
  if (!found) throw new SubmissionNotInCourseError();

  // Flat select+join, never a relational `with:` traversal -- Drizzle's
  // relational builder serializes bytea through JSON, handing
  // encryptedText.fromDriver a hex string instead of a Buffer. Documented at
  // length in repositories/submissions.ts, which decrypts the same way.
  const rows = await db
    .select({
      id: grades.id,
      submissionId: grades.submissionId,
      score: grades.score,
      maxScore: grades.maxScore,
      feedback: grades.feedback,
      gradedByAi: grades.gradedByAi,
      supersedesGradeId: grades.supersedesGradeId,
      graderName: users.displayName,
      gradedAt: grades.gradedAt,
    })
    .from(grades)
    .leftJoin(courseMemberships, eq(grades.graderMembershipId, courseMemberships.id))
    .leftJoin(users, eq(courseMemberships.userId, users.id))
    .where(eq(grades.submissionId, submissionId))
    // Tie-broken on id: two grades written in the same millisecond would
    // otherwise swap places between reads, and the FIRST human row is the
    // one marked current.
    .orderBy(desc(grades.gradedAt), desc(grades.id));

  let currentSeen = false;
  const payloads: GradePayload[] = [];
  for (const r of rows) {
    // The newest human row is in force. An AI row is never in force, however
    // recent -- that is the whole rule.
    const isCurrent = !r.gradedByAi && !currentSeen;
    if (isCurrent) currentSeen = true;
    payloads.push({
      id: r.id,
      submissionId: r.submissionId,
      score: r.score,
      maxScore: r.maxScore,
      feedback: r.feedback ?? "",
      graderType: r.gradedByAi ? "ai" : "human",
      graderName: r.graderName ? await cipher.decryptString(r.graderName) : "",
      supersedesGradeId: r.supersedesGradeId,
      isCurrent,
      createdAt: r.gradedAt.toISOString(),
    });
  }
  return payloads;
}

export interface RecordHumanGradeInput {
  submissionId: string;
  graderMembershipId: string;
  score: number | null;
  maxScore: number | null;
  feedback: string;
  /** The AI draft this was built from, when the instructor started from one.
   *  Recorded so a later reader can tell an independently-written grade from
   *  an approved draft -- which is a materially different provenance for a
   *  grade a student may dispute. */
  supersedesGradeId?: string | null;
}

/** Writes a human grade. Always an INSERT: the previous grade stays, which
 *  is what makes the regrade history real rather than aspirational. */
export async function recordHumanGrade(
  db: Db,
  scope: CourseScope,
  orgScope: OrgScope,
  input: RecordHumanGradeInput,
): Promise<string> {
  const found = await getSubmissionInCourse(db, scope, input.submissionId);
  if (!found) throw new SubmissionNotInCourseError();

  const [created] = await db
    .insert(grades)
    .values({
      organizationId: orgScope,
      submissionId: input.submissionId,
      graderMembershipId: input.graderMembershipId,
      gradedByAi: false,
      score: input.score,
      maxScore: input.maxScore,
      feedback: input.feedback,
      supersedesGradeId: input.supersedesGradeId ?? null,
    })
    .returning({ id: grades.id });
  return created!.id;
}

/** Writes an AI draft. `graderMembershipId` is deliberately absent -- the
 *  schema's grader-consistency CHECK requires it to be NULL when
 *  graded_by_ai is true, so a draft cannot be attributed to a person even by
 *  accident. */
export async function recordAiDraft(
  db: Db,
  scope: CourseScope,
  orgScope: OrgScope,
  input: { submissionId: string; score: number | null; maxScore: number | null; rationale: string; modelName: string },
): Promise<string> {
  const found = await getSubmissionInCourse(db, scope, input.submissionId);
  if (!found) throw new SubmissionNotInCourseError();

  const [created] = await db
    .insert(grades)
    .values({
      organizationId: orgScope,
      submissionId: input.submissionId,
      gradedByAi: true,
      score: input.score,
      maxScore: input.maxScore,
      feedback: input.rationale,
      // The model that produced it, in the rubric column rather than a new
      // one: a draft's provenance is metadata about the draft, and jsonb is
      // where this table already puts grade metadata.
      rubric: { source: "ai_draft", modelName: input.modelName },
    })
    .returning({ id: grades.id });
  return created!.id;
}

/** The caller's own membership on the course, which a human grade must be
 *  attributed to. Returns null for a role that may not grade.
 *
 *  Grading is instructor-tier here, not grader-tier. A TA can READ student
 *  work (#172's requireGraderOf) but a grade is a record a student may
 *  dispute and an institution may be asked to defend, so it is attributed to
 *  someone with authority over the course. `recordGrade`'s own pre-existing
 *  check in repositories/submissions.ts already took this position; this
 *  keeps the two consistent rather than having the route disagree with the
 *  repository. If TA grading is wanted it should be a per-course grant like
 *  canViewSolutions, not a widening of this lookup. */
export async function graderMembershipFor(
  db: Db,
  scope: CourseScope,
  userId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: courseMemberships.id, role: courseMemberships.role })
    .from(courseMemberships)
    .where(and(eq(courseMemberships.userId, userId), eq(courseMemberships.courseId, scope)));
  if (!row) return null;
  return row.role === "instructor" || row.role === "admin" ? row.id : null;
}
