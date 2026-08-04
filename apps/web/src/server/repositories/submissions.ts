import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { submissions, grades, conversations, courses, courseMemberships } from "../../db/schema";
import type { OrgScope } from "./scope";

export async function createSubmission(db: Db, scope: OrgScope, conversationId: string) {
  // The conversation isn't guaranteed to belong to `scope`'s org just
  // because the caller says so -- verify via the real parent chain
  // (conversation -> course -> org) before writing the denormalized
  // organization_id, or a caller-supplied conversationId from a different
  // org gets mislabeled into this org's data.
  const [owned] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .innerJoin(courses, eq(conversations.courseId, courses.id))
    .where(and(eq(conversations.id, conversationId), eq(courses.organizationId, scope)));
  if (!owned) {
    throw new Error("Conversation not found in this org scope");
  }

  const [created] = await db
    .insert(submissions)
    .values({ conversationId, organizationId: scope })
    .returning();
  return created;
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
    // belongs to, not some other course's (or org's) grader.
    const [validGrader] = await db
      .select({ id: courseMemberships.id })
      .from(courseMemberships)
      .innerJoin(conversations, eq(conversations.courseId, courseMemberships.courseId))
      .innerJoin(submissions, eq(submissions.conversationId, conversations.id))
      .where(
        and(
          eq(courseMemberships.id, input.graderMembershipId),
          eq(submissions.id, input.submissionId),
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
