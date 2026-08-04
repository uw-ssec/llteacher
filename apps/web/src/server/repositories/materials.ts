import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { courseMaterials } from "../../db/schema";
import type { CourseScope } from "./scope";

export async function listMaterialsForCourse(db: Db, scope: CourseScope) {
  return db.select().from(courseMaterials).where(eq(courseMaterials.courseId, scope));
}
