import { Hono, type Context } from "hono";
import { makeDb } from "../../db/client";
import { listHomeworksForCourse, createHomework } from "../repositories/homeworks";
import { courseScope } from "../repositories/scope";
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
  const rows = await listHomeworksForCourse(db, courseScope(courseId));
  return c.json({ homeworks: rows });
}

export async function createHomeworkHandler(c: Context<AppEnv>) {
  const courseId = c.req.param("courseId");
  const authContext = c.get("authContext") as AuthContext | undefined;

  // requireInstructorOf already verified courseId is present and
  // authContext exists (it 403s otherwise); guarded again here -- mirrors
  // listHomeworksHandler -- so a dropped/reordered guard fails closed with
  // a 403 instead of throwing past this point (unguarded .memberships
  // access) into the generic 503 handler.
  if (!authContext || !courseId) {
    return c.json({ error: "Course access denied" }, 403);
  }

  let body: CreateHomeworkBody;
  try {
    body = await c.req.json<CreateHomeworkBody>();
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }
  if (
    typeof body.title !== "string" ||
    body.title.trim().length === 0 ||
    typeof body.description !== "string" ||
    typeof body.dueDate !== "string"
  ) {
    return c.json({ error: "title, description, and dueDate are required" }, 400);
  }

  const dueDate = new Date(body.dueDate);
  if (Number.isNaN(dueDate.getTime())) {
    return c.json({ error: "dueDate must be a valid date" }, 400);
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
  const created = await createHomework(db, courseScope(courseId), {
    createdById: membership.id,
    title: body.title.trim(),
    description: body.description,
    dueDate,
  });

  return c.json({ id: created.id }, 201);
}

// Sub-app preserved for direct unit testing; production routing happens via
// app.get/post("/api/courses/:courseId/homeworks", ...) in server/index.ts.
export const homeworksRoutes = new Hono<AppEnv>();
homeworksRoutes.get("/", requireCourseMember()(listHomeworksHandler));
homeworksRoutes.post("/", requireInstructorOf()(createHomeworkHandler));
