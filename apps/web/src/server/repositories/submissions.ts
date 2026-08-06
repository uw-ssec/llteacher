import { and, eq, isNull, or } from "drizzle-orm";
import type { Db } from "../../db/client";
import { submissions, grades, conversations, courses, courseMemberships } from "../../db/schema";
import type { OrgScope } from "./scope";

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
  if (!owned || owned.ownerUserId !== requesterId) {
    throw new Error("Conversation not found or not owned by requester");
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
