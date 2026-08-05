import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { homeworks } from "../../db/schema";
import type { CourseScope } from "./scope";

export async function listHomeworksForCourse(db: Db, scope: CourseScope) {
  return db.query.homeworks.findMany({ where: eq(homeworks.courseId, scope) });
}

export async function createHomework(
  db: Db,
  scope: CourseScope,
  input: { createdById: string; title: string; description: string; dueDate: Date },
) {
  const [created] = await db
    .insert(homeworks)
    .values({ courseId: scope, ...input })
    .returning({ id: homeworks.id });
  return created;
}
