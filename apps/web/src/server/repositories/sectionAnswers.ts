import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { sections, homeworks, courses, sectionAnswers } from "../../db/schema";
import type { OrgScope } from "./scope";

/** #164: verifies (via the real parent chain, never trusting the caller)
 *  that sectionId resolves to a non_interactive section within scope's org
 *  before writing -- same rationale as createSubmission/submitSection's
 *  ownership-verification-via-join pattern (repositories/submissions.ts).
 *  Upsert-on-revise, not a history table: see Resolved Design Decision 19
 *  in the M3 plan. */
export async function upsertSectionAnswer(db: Db, scope: OrgScope, sectionId: string, userId: string, content: string) {
  const [owned] = await db
    .select({ id: sections.id, type: sections.type })
    .from(sections)
    .innerJoin(homeworks, eq(sections.homeworkId, homeworks.id))
    .innerJoin(courses, eq(homeworks.courseId, courses.id))
    .where(and(eq(sections.id, sectionId), eq(courses.organizationId, scope)));
  if (!owned) {
    throw new Error("Section not found in this org scope");
  }
  if (owned.type !== "non_interactive") {
    throw new Error("Section does not accept a direct answer");
  }

  const [existing] = await db
    .select({ id: sectionAnswers.id })
    .from(sectionAnswers)
    .where(and(eq(sectionAnswers.sectionId, sectionId), eq(sectionAnswers.userId, userId)));
  if (existing) {
    const [updated] = await db
      .update(sectionAnswers)
      .set({ content, updatedAt: new Date() })
      .where(eq(sectionAnswers.id, existing.id))
      .returning();
    return updated!;
  }

  const [created] = await db
    .insert(sectionAnswers)
    .values({ sectionId, userId, organizationId: scope, content })
    .returning();
  return created!;
}

export async function getSectionAnswer(db: Db, scope: OrgScope, sectionId: string, userId: string) {
  const [found] = await db
    .select()
    .from(sectionAnswers)
    .where(
      and(
        eq(sectionAnswers.sectionId, sectionId),
        eq(sectionAnswers.userId, userId),
        eq(sectionAnswers.organizationId, scope),
      ),
    );
  return found ?? null;
}
