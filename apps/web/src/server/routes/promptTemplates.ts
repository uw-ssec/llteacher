import { type Context } from "hono";
import { makeDb } from "../../db/client";
import {
  getCourseScopedPromptTemplate,
  upsertCourseScopedPromptTemplate,
  deactivateCourseScopedPromptTemplate,
} from "../repositories/promptTemplates";
import { courseScopeFromAuthContext } from "../repositories/scope";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import type {
  CoursePromptTemplateResponse,
  CoursePromptTemplateUpsertBody,
  CoursePromptTemplateUpsertResponse,
} from "../../shared/types";

const MAX_CONTENT_LENGTH = 20_000;

/** GET: the course's own scoped prompt_templates row, or `promptTemplate:
 *  null` if it has none (resolution falls through to org/default -- see
 *  lib/prompts.ts's resolvePromptTemplate). Backs the instructor-facing
 *  "course tutor prompt" editor: this is what prefills it. */
export async function getCoursePromptTemplateHandler(c: Context<AppEnv>) {
  const courseId = c.req.param("courseId");
  const authContext = c.get("authContext") as AuthContext | undefined;

  // requireInstructorOf already verified this; guarded again here to match
  // every sibling authoring-surface handler (createHomeworkHandler,
  // listLlmConfigsHandler).
  if (!authContext || !courseId || !authContext.isInstructorOf(courseId)) {
    return c.json({ error: "Course access denied" }, 403);
  }
  const scope = courseScopeFromAuthContext(authContext, courseId);
  if (!scope) {
    return c.json({ error: "Course access denied" }, 403);
  }

  const db = makeDb(c.env.DATABASE_URL);
  const row = await getCourseScopedPromptTemplate(db, scope);
  const body: CoursePromptTemplateResponse = {
    promptTemplate: row
      ? {
          id: row.id,
          content: row.content,
          version: row.version,
          composeWithParent: row.composeWithParent,
          updatedAt: row.updatedAt.toISOString(),
        }
      : null,
  };
  return c.json(body);
}

/** PUT: create-or-version-bump the course's scoped prompt_templates row
 *  (upsertCourseScopedPromptTemplate's own doc comment has the versioning
 *  mechanics). The only writer of prompt_templates outside scripts/seed.ts
 *  -- closing the "read-complete, write-empty" gap #325 was filed for. */
export async function putCoursePromptTemplateHandler(c: Context<AppEnv>) {
  const courseId = c.req.param("courseId");
  const authContext = c.get("authContext") as AuthContext | undefined;

  if (!authContext || !courseId || !authContext.isInstructorOf(courseId)) {
    return c.json({ error: "Course access denied" }, 403);
  }
  const scope = courseScopeFromAuthContext(authContext, courseId);
  if (!scope) {
    return c.json({ error: "Course access denied" }, 403);
  }

  let body: CoursePromptTemplateUpsertBody;
  try {
    body = await c.req.json<CoursePromptTemplateUpsertBody>();
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }
  if (typeof body.content !== "string" || body.content.trim().length === 0) {
    return c.json({ error: "content is required" }, 400);
  }
  if (body.content.length > MAX_CONTENT_LENGTH) {
    return c.json({ error: `content must be ${MAX_CONTENT_LENGTH} characters or fewer` }, 400);
  }
  if (body.composeWithParent !== undefined && typeof body.composeWithParent !== "boolean") {
    return c.json({ error: "composeWithParent must be a boolean" }, 400);
  }
  // #317 review, #347 (requirement 1): resolveFromLevel (lib/prompts.ts)
  // genuinely composes parent + child content -- but only on the FRESH
  // resolution path. Every turn after the first reads the pinned row by id
  // via getPinnedPromptTemplateContent, which selects `content` alone with
  // no composition, so a true value here silently does nothing from turn 2
  // onward: the instructor sees the toggle saved, gets a composed prompt
  // once, then a truncated one for the rest of the conversation's life.
  // Rejected here instead, until the pinned-read path can recompose (or
  // conversations pin the resolved string, not just an id) -- refusing is
  // the honest option; a silent no-op is what got this issue filed.
  if (body.composeWithParent === true) {
    return c.json(
      { error: "composeWithParent is not yet supported -- pinned conversations do not recompose it" },
      400,
    );
  }

  const db = makeDb(c.env.DATABASE_URL);
  const result = await upsertCourseScopedPromptTemplate(db, scope, {
    content: body.content,
    composeWithParent: body.composeWithParent ?? false,
  });
  const responseBody: CoursePromptTemplateUpsertResponse = result;
  return c.json(responseBody, 200);
}

/** DELETE: deactivate the course's scoped prompt_templates row, reverting
 *  resolution to whatever the org level (or DEFAULT_SYSTEM_PROMPT) provides
 *  -- see deactivateCourseScopedPromptTemplate's own doc comment. */
export async function deleteCoursePromptTemplateHandler(c: Context<AppEnv>) {
  const courseId = c.req.param("courseId");
  const authContext = c.get("authContext") as AuthContext | undefined;

  if (!authContext || !courseId || !authContext.isInstructorOf(courseId)) {
    return c.json({ error: "Course access denied" }, 403);
  }
  const scope = courseScopeFromAuthContext(authContext, courseId);
  if (!scope) {
    return c.json({ error: "Course access denied" }, 403);
  }

  const db = makeDb(c.env.DATABASE_URL);
  await deactivateCourseScopedPromptTemplate(db, scope);
  return c.body(null, 204);
}
