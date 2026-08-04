import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { submissions, grades } from "../../db/schema";
import type { OrgScope } from "./scope";

export async function createSubmission(db: Db, scope: OrgScope, conversationId: string) {
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
  const [created] = await db
    .insert(grades)
    .values({ organizationId: scope, ...input })
    .returning();
  return created;
}
