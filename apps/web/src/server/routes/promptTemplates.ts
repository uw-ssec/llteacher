import { type Context } from "hono";
import { Effect } from "effect";
import {
  getCourseScopedPromptTemplate,
  upsertCourseScopedPromptTemplate,
  deactivateCourseScopedPromptTemplate,
} from "../repositories/promptTemplates";
import { PromptTemplateConflictError } from "../repositories/errors";
import { courseScopeFromAuthContext, type CourseScope } from "../repositories/scope";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import type {
  CoursePromptTemplateResponse,
  CoursePromptTemplateUpsertBody,
  CoursePromptTemplateUpsertResponse,
} from "../../shared/types";
import { BadRequest, Forbidden } from "../effect/errors";
import { effectHandler } from "../effect/http";
import { query } from "../effect/services";

const MAX_CONTENT_LENGTH = 20_000;

/** requireInstructorOf already verified this; guarded again here to match
 *  every sibling authoring-surface handler (createHomeworkHandler,
 *  listLlmConfigsHandler). */
function instructorCourseScope(c: Context<AppEnv>): Effect.Effect<CourseScope, Forbidden> {
  const courseId = c.req.param("courseId");
  const authContext = c.get("authContext") as AuthContext | undefined;
  const scope =
    authContext && courseId && authContext.isInstructorOf(courseId)
      ? courseScopeFromAuthContext(authContext, courseId)
      : null;
  return scope ? Effect.succeed(scope) : Effect.fail(new Forbidden({ message: "Course access denied" }));
}

/** GET: the course's own scoped prompt_templates row, or `promptTemplate:
 *  null` if it has none (resolution falls through to org/default -- see
 *  lib/prompts.ts's resolvePromptTemplate). Backs the instructor-facing
 *  "course tutor prompt" editor: this is what prefills it. */
export const getCoursePromptTemplateHandler = effectHandler((c) => Effect.gen(function* () {
  const scope = yield* instructorCourseScope(c);

  const row = yield* query("getCourseScopedPromptTemplate", (db) => getCourseScopedPromptTemplate(db, scope));
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
}));

/** PUT: create-or-version-bump the course's scoped prompt_templates row
 *  (upsertCourseScopedPromptTemplate's own doc comment has the versioning
 *  mechanics). The only writer of prompt_templates outside scripts/seed.ts
 *  -- closing the "read-complete, write-empty" gap #325 was filed for. */
export const putCoursePromptTemplateHandler = effectHandler((c) => Effect.gen(function* () {
  const scope = yield* instructorCourseScope(c);

  const body = yield* Effect.tryPromise({
    try: () => c.req.json<CoursePromptTemplateUpsertBody>(),
    catch: () => new BadRequest({ message: "Request body must be valid JSON" }),
  });
  const content = body.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    return yield* new BadRequest({ message: "content is required" });
  }
  if (content.length > MAX_CONTENT_LENGTH) {
    return yield* new BadRequest({ message: `content must be ${MAX_CONTENT_LENGTH} characters or fewer` });
  }
  if (body.composeWithParent !== undefined && typeof body.composeWithParent !== "boolean") {
    return yield* new BadRequest({ message: "composeWithParent must be a boolean" });
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
    return yield* new BadRequest({
      message: "composeWithParent is not yet supported -- pinned conversations do not recompose it",
    });
  }

  const composeWithParent = body.composeWithParent ?? false;
  // PromptTemplateConflictError (two concurrent saves losing the partial
  // unique index race) stays typed and is answered 409 by the bridge.
  const result = yield* query(
    "upsertCourseScopedPromptTemplate",
    (db) => upsertCourseScopedPromptTemplate(db, scope, { content, composeWithParent }),
    [PromptTemplateConflictError],
  );
  const responseBody: CoursePromptTemplateUpsertResponse = result;
  return c.json(responseBody, 200);
}));

/** DELETE: deactivate the course's scoped prompt_templates row, reverting
 *  resolution to whatever the org level (or DEFAULT_SYSTEM_PROMPT) provides
 *  -- see deactivateCourseScopedPromptTemplate's own doc comment. */
export const deleteCoursePromptTemplateHandler = effectHandler((c) => Effect.gen(function* () {
  const scope = yield* instructorCourseScope(c);

  yield* query("deactivateCourseScopedPromptTemplate", (db) => deactivateCourseScopedPromptTemplate(db, scope));
  return c.body(null, 204);
}));
