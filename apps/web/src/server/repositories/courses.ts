import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { courses, organizations } from "../../db/schema";
import type { CourseScope, OrgScope } from "./scope";

/** The course's display title, or null if the row is gone. Used to name
 *  files an instructor takes away from the console. */
export async function getCourseTitle(db: Db, courseId: string): Promise<string | null> {
  const [row] = await db.select({ title: courses.title }).from(courses).where(eq(courses.id, courseId));
  return row?.title ?? null;
}

/** Both layers, for the console: the course's own text and the
 *  organisation's default it would otherwise fall back to. */
export async function getKnowledgeInstructionParts(
  db: Db,
  courseId: string,
): Promise<{ instruction: string | null; orgDefault: string | null }> {
  const [row] = await db
    .select({ instruction: courses.knowledgeInstruction, orgDefault: organizations.knowledgeInstructionDefault })
    .from(courses)
    .innerJoin(organizations, eq(organizations.id, courses.organizationId))
    .where(eq(courses.id, courseId));
  return { instruction: row?.instruction ?? null, orgDefault: row?.orgDefault ?? null };
}

/** What the chat injects: the course's own text, else the organisation's
 *  default, else null (the built-in). */
export async function getKnowledgeInstruction(db: Db, courseId: string): Promise<string | null> {
  const parts = await getKnowledgeInstructionParts(db, courseId);
  return parts.instruction ?? parts.orgDefault;
}

export async function setKnowledgeInstruction(db: Db, scope: CourseScope, instruction: string | null): Promise<void> {
  await db.update(courses).set({ knowledgeInstruction: instruction, updatedAt: new Date() }).where(eq(courses.id, scope));
}

/** The organisation-wide default, set from any of its courses. */
export async function setKnowledgeInstructionDefault(db: Db, scope: OrgScope, instruction: string | null): Promise<void> {
  await db.update(organizations).set({ knowledgeInstructionDefault: instruction, updatedAt: new Date() }).where(eq(organizations.id, scope));
}
