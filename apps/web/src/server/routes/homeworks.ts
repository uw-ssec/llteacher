import { Hono, type Context } from "hono";
import { makeDb } from "../../db/client";
import { listHomeworksForCourse, createHomework, getHomeworkById, deriveHomeworkStatus, updateHomework, deleteHomework } from "../repositories/homeworks";
import { courseScopeFromAuthContext } from "../repositories/scope";
import { requireCourseMember, requireInstructorOf } from "../utils/guards";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import type { HomeworkDetailResponse, HomeworkUpdateBody, SectionResponse } from "../../shared/types";

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
  const scope = authContext && courseId ? courseScopeFromAuthContext(authContext, courseId) : null;
  if (!scope) {
    return c.json({ error: "Course access denied" }, 403);
  }

  const db = makeDb(c.env.DATABASE_URL);
  const rows = await listHomeworksForCourse(db, scope);
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
  const scope = courseScopeFromAuthContext(authContext, courseId);
  if (!membership || !scope) {
    // requireInstructorOf already verified isInstructorOf(courseId), which
    // is derived from this same memberships list, so this should be
    // unreachable -- guarded defensively rather than trusting that
    // invariant silently.
    return c.json({ error: "Course access denied" }, 403);
  }

  const db = makeDb(c.env.DATABASE_URL);
  const created = await createHomework(db, scope, {
    createdById: membership.id,
    title: body.title.trim(),
    description: body.description,
    dueDate,
  });

  return c.json({ id: created.id }, 201);
}

export async function getHomeworkDetailHandler(c: Context<AppEnv>) {
  const courseId = c.req.param("courseId");
  const homeworkId = c.req.param("homeworkId");
  const authContext = c.get("authContext") as AuthContext | undefined;

  // requireCourseMember already verified isMemberOf(courseId) when this
  // handler is reached via the guarded production route; guarded
  // defensively here too (mirrors listHomeworksHandler above).
  const scope = authContext && courseId ? courseScopeFromAuthContext(authContext, courseId) : null;
  if (!scope) {
    return c.json({ error: "Course access denied" }, 403);
  }

  const db = makeDb(c.env.DATABASE_URL);
  const result = await getHomeworkById(db, scope, homeworkId!);
  if (!result) {
    return c.json({ error: "Homework not found" }, 404);
  }

  const sectionsResponse: SectionResponse[] = result.sections.map((s) => ({
    id: s.id,
    title: s.title,
    content: s.content,
    order: s.order,
    solution: s.solution ? { id: s.solution.id, content: s.solution.content } : null,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  }));

  const body: HomeworkDetailResponse = {
    id: result.homework.id,
    courseId: result.homework.courseId,
    title: result.homework.title,
    description: result.homework.description,
    dueDate: result.homework.dueDate.toISOString(),
    llmConfigId: result.homework.llmConfigId,
    status: deriveHomeworkStatus(result.homework),
    publishedAt: result.homework.publishedAt?.toISOString() ?? null,
    releasedAt: result.homework.releasedAt?.toISOString() ?? null,
    sections: sectionsResponse,
    ...(authContext!.isInstructorOf(courseId!) && { editableBy: true }),
  };

  return c.json(body);
}

export async function updateHomeworkHandler(c: Context<AppEnv>) {
  const courseId = c.req.param("courseId");
  const homeworkId = c.req.param("homeworkId");
  const authContext = c.get("authContext") as AuthContext | undefined;

  // requireInstructorOf already verified courseId is present and
  // isInstructorOf(courseId) when this handler is reached via the guarded
  // production route; guarded again here -- mirrors createHomeworkHandler --
  // so a dropped/reordered guard fails closed with a 403 instead of
  // throwing past this point into the generic 503 handler.
  if (!authContext || !courseId || !authContext.isInstructorOf(courseId)) {
    return c.json({ error: "Instructor access denied" }, 403);
  }

  let body: HomeworkUpdateBody;
  try {
    body = await c.req.json<HomeworkUpdateBody>();
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }

  let dueDate: Date | undefined;
  if (body.dueDate !== undefined) {
    dueDate = new Date(body.dueDate);
    if (Number.isNaN(dueDate.getTime())) {
      return c.json({ error: "dueDate must be a valid date" }, 400);
    }
  }

  const scope = courseScopeFromAuthContext(authContext, courseId);
  if (!scope) {
    // requireInstructorOf already verified isInstructorOf(courseId), which
    // is derived from this same memberships list, so this should be
    // unreachable -- guarded defensively rather than trusting that
    // invariant silently.
    return c.json({ error: "Course access denied" }, 403);
  }

  const db = makeDb(c.env.DATABASE_URL);
  try {
    const result = await updateHomework(db, scope, homeworkId!, {
      title: body.title,
      description: body.description,
      dueDate,
      llmConfigId: body.llmConfigId,
      sections: body.sections,
    });
    if (!result) {
      return c.json({ error: "Homework not found" }, 404);
    }
    return c.json(result);
  } catch (err) {
    // planSectionDiff/resolveSectionWrites (Task 2/3) throw a plain Error
    // for two distinct client-input problems: a duplicate/out-of-range
    // section order, and an unresolvable reorder cycle. Every message on
    // that path contains "order" or "section" (see repositories/sections.ts
    // and repositories/homeworks.ts's resolveSectionWrites) -- this regex
    // maps both to a 422 with the underlying message surfaced to the
    // client. Typed-error mapping is tracked separately (#141); anything
    // that doesn't match falls through to app.onError's generic 503.
    const message = err instanceof Error ? err.message : "Invalid section data";
    if (/order|section/i.test(message)) {
      return c.json({ error: message }, 422);
    }
    throw err;
  }
}

export async function deleteHomeworkHandler(c: Context<AppEnv>) {
  const courseId = c.req.param("courseId");
  const homeworkId = c.req.param("homeworkId");
  const authContext = c.get("authContext") as AuthContext | undefined;

  if (!authContext || !courseId || !authContext.isInstructorOf(courseId)) {
    return c.json({ error: "Instructor access denied" }, 403);
  }
  const scope = courseScopeFromAuthContext(authContext, courseId);
  if (!scope) return c.json({ error: "Course access denied" }, 403);

  const db = makeDb(c.env.DATABASE_URL);
  const deleted = await deleteHomework(db, scope, homeworkId!);
  if (!deleted) return c.json({ error: "Homework not found" }, 404);
  return c.body(null, 204);
}

// Sub-app preserved for direct unit testing; production routing happens via
// app.get/post("/api/courses/:courseId/homeworks", ...) in server/index.ts.
export const homeworksRoutes = new Hono<AppEnv>();
homeworksRoutes.get("/", requireCourseMember()(listHomeworksHandler));
homeworksRoutes.post("/", requireInstructorOf()(createHomeworkHandler));
homeworksRoutes.get("/:homeworkId", requireCourseMember()(getHomeworkDetailHandler));
homeworksRoutes.patch("/:homeworkId", requireInstructorOf()(updateHomeworkHandler));
homeworksRoutes.delete("/:homeworkId", requireInstructorOf()(deleteHomeworkHandler));
