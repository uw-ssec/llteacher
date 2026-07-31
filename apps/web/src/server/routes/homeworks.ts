import { Hono, type Context } from "hono";
import { eq } from "drizzle-orm";
import { makeDb } from "../../db/client";
import { homeworks } from "../../db/schema";
import { requireCourseMember, requireInstructorOf } from "../utils/guards";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";

interface CreateHomeworkBody {
  title?: unknown;
  description?: unknown;
  dueDate?: unknown;
}

export async function listHomeworksHandler(c: Context<AppEnv>) {
  const courseId = c.req.param("courseId");
  const authContext = c.get("authContext") as AuthContext | undefined;

  // requireCourseMember already verified isMemberOf(courseId) when this
  // handler is reached via the guarded production route; guarded
  // defensively here too (mirrors createHomeworkHandler below) so the
  // handler is never reachable unauthorized even if wired up unguarded.
  if (!authContext || !courseId || !authContext.isMemberOf(courseId)) {
    return c.json({ error: "Course access denied" }, 403);
  }

  const db = makeDb(c.env.DATABASE_URL);
  const rows = await db.query.homeworks.findMany({ where: eq(homeworks.courseId, courseId) });
  return c.json({ homeworks: rows });
}

export async function createHomeworkHandler(c: Context<AppEnv>) {
  const courseId = c.req.param("courseId");
  const authContext = c.get("authContext") as AuthContext;

  // requireInstructorOf already verified courseId is present (it 403s
  // otherwise); narrowed again here so TS knows courseId is a definite
  // string, not `string | undefined`, by the time it's used in .values().
  if (!courseId) {
    return c.json({ error: "Course access denied" }, 403);
  }

  const body = await c.req.json<CreateHomeworkBody>();
  if (
    typeof body.title !== "string" ||
    body.title.trim().length === 0 ||
    typeof body.description !== "string" ||
    typeof body.dueDate !== "string"
  ) {
    return c.json({ error: "title, description, and dueDate are required" }, 400);
  }

  const membership = authContext.memberships.find((m) => m.courseId === courseId);
  if (!membership) {
    // requireInstructorOf already verified isInstructorOf(courseId), which
    // is derived from this same memberships list, so this should be
    // unreachable -- guarded defensively rather than trusting that
    // invariant silently.
    return c.json({ error: "Course access denied" }, 403);
  }

  const db = makeDb(c.env.DATABASE_URL);
  const [created] = await db
    .insert(homeworks)
    .values({
      courseId,
      createdById: membership.id,
      title: body.title.trim(),
      description: body.description,
      dueDate: new Date(body.dueDate),
    })
    .returning({ id: homeworks.id });

  return c.json({ id: created.id }, 201);
}

// Sub-app preserved for direct unit testing; production routing happens via
// app.get/post("/api/courses/:courseId/homeworks", ...) in server/index.ts.
export const homeworksRoutes = new Hono<AppEnv>();
homeworksRoutes.get("/", requireCourseMember()(listHomeworksHandler));
homeworksRoutes.post("/", requireInstructorOf()(createHomeworkHandler));
