import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { courses } from "../../db/schema";

/** The course's display title, or null if the row is gone. Used to name
 *  files an instructor takes away from the console. */
export async function getCourseTitle(db: Db, courseId: string): Promise<string | null> {
  const [row] = await db.select({ title: courses.title }).from(courses).where(eq(courses.id, courseId));
  return row?.title ?? null;
}
