import { Effect } from "effect";
import {
  listHomeworksForCourse,
  createHomework,
  getHomeworkById,
  deriveHomeworkStatus,
  updateHomework,
  deleteHomework,
  updateHomeworkPublishState,
  updateHomeworkHideState,
  homeworkHasStudentActivity,
  isUnreleased,
} from "../repositories/homeworks";
import { getOrgScopesForUser } from "../repositories/users";
import { getOrgScopeForCourse } from "../repositories/organizations";
import { llmConfigBelongsToOrg } from "../repositories/llmConfigs";
import { courseScopeFromAuthContext } from "../repositories/scope";
import { ContentDiffError } from "../repositories/sections";
import { UUID_RE } from "../utils/uuid";
import { AUDIT_ACTIONS, auditBestEffort } from "../utils/audit";
import { logServerError } from "../utils/errors";
import type { AppEnv } from "../context";
import type { Context } from "hono";
import type {
  HomeworkDetailResponse,
  HomeworkHideBody,
  HomeworkHideResponse,
  HomeworkPublishBody,
  HomeworkPublishResponse,
  HomeworkUpdateBody,
  SectionResponse,
} from "../../shared/types";
import { BadRequest, Forbidden, NotFound } from "../effect/errors";
import { effectHandler, requireCourseAccess } from "../effect/http";
import { query } from "../effect/services";

interface CreateHomeworkBody {
  title?: unknown;
  description?: unknown;
  dueDate?: unknown;
}

// #317 review, #349 (requirement 4): sections.content (the problem
// statement) had no length bound anywhere -- no maxLength on the admin
// textarea, no route validation, unlike routes/promptTemplates.ts's own
// MAX_CONTENT_LENGTH for template content. It reaches the model's context
// at least twice per turn (assembleSystemPrompt's <section_content> block,
// and again as the persisted greeting -- lib/prompts.ts), so an unbounded
// value here is an unbounded, uncapped cost per turn for the life of the
// section, not just a one-time write. Same limit as MAX_CONTENT_LENGTH
// (promptTemplates.ts) for consistency; nothing here requires it to match,
// but there's no reason to invent a second number.
const MAX_SECTION_CONTENT_LENGTH = 20_000;

/** Every not-found answer in this file shares one body, so a malformed id,
 *  a missing row and a hidden one are indistinguishable. */
const homeworkNotFound = () => new NotFound({ message: "Homework not found" });

/** A body that isn't JSON at all is a client error, not an outage. */
function readJsonBody<T>(c: Context<AppEnv>): Effect.Effect<T, BadRequest> {
  return Effect.tryPromise({
    try: () => c.req.json<T>(),
    catch: () => new BadRequest({ message: "Request body must be valid JSON" }),
  });
}

export const listHomeworksHandler = effectHandler((c) => Effect.gen(function* () {
  // requireCourseMember already verified isMemberOf(courseId) when this
  // handler is reached via the guarded production route; guarded
  // defensively here too (mirrors createHomeworkHandler below) so the
  // handler is never reachable unauthorized even if wired up unguarded.
  const { authContext, courseId, scope } = yield* requireCourseAccess(c);

  const rows = yield* query("listHomeworksForCourse", (db) => listHomeworksForCourse(db, scope));
  // #166: instructors continue to see hidden/expired homeworks (labelled as
  // such); students never see them, same gate as draft/scheduled.
  // #172: now keyed on the unreleased-content capability rather than the
  // authoring role, so a TA granted `can_view_drafts` on this course sees
  // them too. Instructors/admins satisfy it unconditionally.
  const visibleRows = authContext.canViewDraftsIn(courseId)
    ? rows
    : rows.filter((hw) => !isUnreleased(hw.status));
  return c.json({ homeworks: visibleRows });
}));

export const createHomeworkHandler = effectHandler((c) => Effect.gen(function* () {
  const courseId = c.req.param("courseId");
  const authContext = c.get("authContext");

  // requireInstructorOf already verified courseId is present and
  // authContext exists (it 403s otherwise); guarded again here -- mirrors
  // listHomeworksHandler -- so a dropped/reordered guard fails closed with
  // a 403 instead of throwing past this point (unguarded .memberships
  // access) into the generic 503 handler.
  // #200 (#172 re-audit, MNT-025): the isInstructorOf re-check that every
  // sibling authoring handler already had and this one did not. Not reachable
  // through the production route table -- requireInstructorOf wraps it there,
  // and routeGuards.test.ts pins that -- so this is defence in depth, closing
  // the gap the moment a new sub-app or test harness wires the handler
  // unguarded, which is exactly how the drift #172 fixed happened the first
  // time. It also makes true a comment in courseMemberships.ts that claimed
  // "every other instructor-gated handler" re-checks; four of five did.
  if (!authContext || !courseId || !authContext.isInstructorOf(courseId)) {
    return yield* new Forbidden({ message: "Course access denied" });
  }

  const body = yield* readJsonBody<CreateHomeworkBody>(c);
  if (
    typeof body.title !== "string" ||
    body.title.trim().length === 0 ||
    typeof body.description !== "string" ||
    typeof body.dueDate !== "string"
  ) {
    return yield* new BadRequest({ message: "title, description, and dueDate are required" });
  }
  const title = body.title.trim();
  const description = body.description;

  const dueDate = new Date(body.dueDate);
  if (Number.isNaN(dueDate.getTime())) {
    return yield* new BadRequest({ message: "dueDate must be a valid date" });
  }

  const membership = authContext.memberships.find((m) => m.courseId === courseId);
  const scope = courseScopeFromAuthContext(authContext, courseId);
  if (!membership || !scope) {
    // requireInstructorOf already verified isInstructorOf(courseId), which
    // is derived from this same memberships list, so this should be
    // unreachable -- guarded defensively rather than trusting that
    // invariant silently.
    return yield* new Forbidden({ message: "Course access denied" });
  }

  const created = yield* query("createHomework", (db) => createHomework(db, scope, {
    createdById: membership.id,
    title,
    description,
    dueDate,
  }));

  return c.json({ id: created.id }, 201);
}));

export const getHomeworkDetailHandler = effectHandler((c) => Effect.gen(function* () {
  const homeworkId = c.req.param("homeworkId");

  // requireCourseMember already verified isMemberOf(courseId) when this
  // handler is reached via the guarded production route; guarded
  // defensively here too (mirrors listHomeworksHandler above).
  const { authContext, courseId, scope } = yield* requireCourseAccess(c);

  // #206 (#172 re-audit, SEC-020): shape-checked before the id reaches a
  // uuid-typed column comparison. Postgres raises `invalid input syntax for
  // type uuid` on a malformed value, app.onError maps any throw to a generic
  // 503, and a permanent client error therefore reported itself as a backend
  // outage -- pollutable by any authenticated member on attacker-chosen
  // input. SEC-003 fixed exactly this for membershipId and its shared helper
  // claimed to cover "every UUID path param"; three were left behind.
  //
  // Returns this route's OWN not-found body, not a shared one: a distinct
  // message here would distinguish "malformed" from "no such row" and hand
  // back an existence oracle.
  if (!homeworkId || !UUID_RE.test(homeworkId)) {
    return yield* homeworkNotFound();
  }

  const result = yield* query("getHomeworkById", (db) => getHomeworkById(db, scope, homeworkId));
  if (!result) {
    return yield* homeworkNotFound();
  }

  // #155/#156: solutions and draft/scheduled homeworks are instructor-only.
  // Hoisted above the response build (rather than computed per-field) so
  // both gates share one check and neither can be added back independently
  // without the other -- reviewed together in #154 because they're the same
  // handler and the same class of bug (a role check the list route and the
  // student repository both already apply, that this route skipped).
  // #172: three independent questions, previously conflated into one
  // isInstructorOf check. Separated because a TA can hold any subset:
  //   canEdit         -- authoring; never granted to a TA
  //   canSeeUnreleased -- draft/scheduled/hidden visibility; TA opt-in
  //   canSeeSolutions  -- the answer key; TA opt-in, granted separately
  // Instructors/admins satisfy all three unconditionally.
  const canEdit = authContext.isInstructorOf(courseId);
  const canSeeUnreleased = authContext.canViewDraftsIn(courseId);
  const canSeeSolutions = authContext.canViewSolutionsIn(courseId);

  const status = deriveHomeworkStatus(result.homework);
  // #166: hidden/expired is the same gate as draft/scheduled for anyone
  // without unreleased-content access -- indistinguishable from not-found,
  // so a guessed/leaked UUID can't confirm a hidden/draft homework is real.
  if (!canSeeUnreleased && isUnreleased(status)) {
    return yield* homeworkNotFound();
  }

  const sectionsResponse: SectionResponse[] = result.sections.map((s) => ({
    id: s.id,
    title: s.title,
    content: s.content,
    order: s.order,
    type: s.type,
    solution: canSeeSolutions && s.solution ? { id: s.solution.id, content: s.solution.content } : null,
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
    status,
    publishedAt: result.homework.publishedAt?.toISOString() ?? null,
    releasedAt: result.homework.releasedAt?.toISOString() ?? null,
    isHidden: result.homework.isHidden,
    expiresAt: result.homework.expiresAt?.toISOString() ?? null,
    sections: sectionsResponse,
    widgets: result.widgets.map((w) => ({ id: w.id, prePrompt: w.prePrompt, postPrompt: w.postPrompt, order: w.order })),
    ...(canEdit && { editableBy: true }),
  };

  return c.json(body);
}));

/** SQLSTATE class 22 (data exception) or a NOT NULL (23502) / CHECK
 *  (23514) violation: Postgres refusing a value the client supplied. */
function isInvalidContentFailure(cause: unknown): boolean {
  const code = typeof cause === "object" && cause !== null ? (cause as { code?: unknown }).code : undefined;
  return typeof code === "string" && (code.startsWith("22") || code === "23502" || code === "23514");
}

export const updateHomeworkHandler = effectHandler((c) => Effect.gen(function* () {
  const courseId = c.req.param("courseId");
  const homeworkId = c.req.param("homeworkId");
  const authContext = c.get("authContext");

  // requireInstructorOf already verified courseId is present and
  // isInstructorOf(courseId) when this handler is reached via the guarded
  // production route; guarded again here -- mirrors createHomeworkHandler --
  // so a dropped/reordered guard fails closed with a 403 instead of
  // throwing past this point into the generic 503 handler.
  if (!authContext || !courseId || !authContext.isInstructorOf(courseId)) {
    return yield* new Forbidden({ message: "Instructor access denied" });
  }

  // #211 (review of #209): SEC-020 shape-checked :homeworkId on the three
  // read routes but left the four mutation routes in this file passing it
  // straight to a uuid-typed column comparison -- same bug class, same
  // consequence (Postgres `invalid input syntax for type uuid` -> app.onError
  // -> a generic 503 for what is a permanent client error). Instructor-gated,
  // so not an authorization or disclosure issue, only a misreported one.
  //
  // Placed after the authorization guard and before body parsing, so the
  // ordering is uniform across all four handlers: authorize, then validate
  // the path param, then validate the body. Returns this route's own
  // not-found body -- a distinct "malformed" message would separate it from
  // "no such row" and hand back an existence oracle.
  if (!homeworkId || !UUID_RE.test(homeworkId)) {
    return yield* homeworkNotFound();
  }

  const body = yield* readJsonBody<HomeworkUpdateBody>(c);

  if (body.sections) {
    for (const section of body.sections) {
      if (typeof section.content === "string" && section.content.length > MAX_SECTION_CONTENT_LENGTH) {
        return yield* new BadRequest({
          message: `Each section's content must be ${MAX_SECTION_CONTENT_LENGTH} characters or fewer`,
        });
      }
    }
  }

  let dueDate: Date | undefined;
  if (body.dueDate !== undefined) {
    dueDate = new Date(body.dueDate);
    if (Number.isNaN(dueDate.getTime())) {
      return yield* new BadRequest({ message: "dueDate must be a valid date" });
    }
  }

  // An uncontrolled <select> (apps/admin's HomeworkForm) always sends a
  // string, never `undefined`, for its "(course/org default)" option --
  // that arrives here as `""`. Normalize it to `null` (explicit clear,
  // matching the option's own label) rather than letting it reach
  // updateHomework's `!== undefined` guard, which would otherwise pass ""
  // straight into `UPDATE homeworks SET llm_config_id = ''` against a uuid
  // column (Postgres throws, unmatched by the 422 regex below, becomes a
  // generic 503 -- this was invisible until the admin write paths started
  // checking res.ok). Any other non-empty value must look like a UUID --
  // apps/admin's LLM_CONFIGS fixture data uses non-UUID placeholder ids
  // ("cfg-1" etc.) with no real GET /api/llm-configs endpoint behind it yet,
  // so selecting one from the dropdown correctly 400s here until that
  // endpoint exists (out of scope for this milestone).
  let llmConfigId = body.llmConfigId;
  if (llmConfigId === "") llmConfigId = null;
  if (llmConfigId != null && !UUID_RE.test(llmConfigId)) {
    return yield* new BadRequest({ message: "llmConfigId must be a valid UUID or null" });
  }

  const scope = courseScopeFromAuthContext(authContext, courseId);
  if (!scope) {
    // requireInstructorOf already verified isInstructorOf(courseId), which
    // is derived from this same memberships list, so this should be
    // unreachable -- guarded defensively rather than trusting that
    // invariant silently.
    return yield* new Forbidden({ message: "Course access denied" });
  }

  // #161: the FK on homeworks.llm_config_id only requires the row to exist
  // somewhere, not that it belongs to this course's organization -- without
  // this, an instructor could point a homework at another tenant's llmConfig
  // (and, once M4 resolves credentials through this column, another
  // tenant's provider credentials). Scoped to this course's own org, not
  // every org the caller belongs to -- see getOrgScopeForCourse's docstring.
  if (llmConfigId != null) {
    const configId = llmConfigId;
    const courseOrgScope = yield* query("getOrgScopeForCourse", (db) => getOrgScopeForCourse(db, courseId));
    const belongsToOrg = courseOrgScope
      ? yield* query("llmConfigBelongsToOrg", (db) => llmConfigBelongsToOrg(db, courseOrgScope, configId))
      : false;
    if (!belongsToOrg) {
      return yield* new BadRequest({ message: "llmConfigId does not belong to this course's organization" });
    }
  }

  return yield* query(
    "updateHomework",
    (db) => updateHomework(db, scope, homeworkId, {
      title: body.title,
      description: body.description,
      dueDate,
      llmConfigId,
      sections: body.sections,
      widgets: body.widgets,
    }),
    [ContentDiffError],
  ).pipe(
    Effect.flatMap((result): Effect.Effect<Response, NotFound> =>
      result ? Effect.succeed(c.json(result)) : Effect.fail(homeworkNotFound())),
    Effect.catchTags({
      // planSectionDiff/planWidgetDiff and the reorder resolvers (Task 2/3,
      // #165) refuse client input they cannot apply: a duplicate or
      // out-of-range order, an id outside this homework, an unresolvable
      // reorder cycle. 422 with the underlying message surfaced to the
      // client, as before. 422 has no HttpError outcome, so it is built
      // here as a response rather than failed. This replaces the old
      // /order|section/ message regex (#141), which also caught -- and
      // leaked to the client -- unrelated Postgres errors that happened to
      // mention a sections table; those are now a DatabaseError (503).
      ContentDiffError: (err) => Effect.succeed(c.json({ error: err.message }, 422)),
      // Section/widget fields the route does not validate itself (a null
      // title, an unknown section type) are refused by Postgres as a data
      // exception (SQLSTATE class 22) or a NOT NULL / CHECK violation. Those
      // are the client's input, so they stay a 422 -- but with a fixed
      // message, never the driver's text. Every other database failure is
      // still an outage (503).
      DatabaseError: (err) =>
        isInvalidContentFailure(err.cause)
          ? Effect.succeed(c.json({ error: "Section or widget content is invalid." }, 422))
          : Effect.fail(err),
    }),
  );
}));

export const deleteHomeworkHandler = effectHandler((c) => Effect.gen(function* () {
  const courseId = c.req.param("courseId");
  const homeworkId = c.req.param("homeworkId");
  const authContext = c.get("authContext");

  if (!authContext || !courseId || !authContext.isInstructorOf(courseId)) {
    return yield* new Forbidden({ message: "Instructor access denied" });
  }

  // #211, same guard and same rationale as updateHomeworkHandler above.
  if (!homeworkId || !UUID_RE.test(homeworkId)) {
    return yield* homeworkNotFound();
  }

  const scope = courseScopeFromAuthContext(authContext, courseId);
  if (!scope) return yield* new Forbidden({ message: "Course access denied" });

  const deleted = yield* query("deleteHomework", (db) => deleteHomework(db, scope, homeworkId));
  if (!deleted) return yield* homeworkNotFound();
  return c.body(null, 204);
}));

export const publishHomeworkHandler = effectHandler((c) => Effect.gen(function* () {
  const courseId = c.req.param("courseId");
  const homeworkId = c.req.param("homeworkId");
  const authContext = c.get("authContext");

  if (!authContext || !courseId || !authContext.isInstructorOf(courseId)) {
    return yield* new Forbidden({ message: "Instructor access denied" });
  }

  // #211, same guard and same rationale as updateHomeworkHandler above.
  if (!homeworkId || !UUID_RE.test(homeworkId)) {
    return yield* homeworkNotFound();
  }

  const body = yield* readJsonBody<HomeworkPublishBody>(c);
  if (typeof body.publish !== "boolean") {
    return yield* new BadRequest({ message: "publish (boolean) is required" });
  }

  let releasedAt: Date | undefined;
  if (body.publish && body.releasedAt) {
    // An uncontrolled <input type="datetime-local"> (apps/admin's
    // HomeworkForm) sends "" for an untouched field, never undefined --
    // same class of bug as the C1 llmConfigId fix above. releasedAt is
    // also irrelevant when unpublishing (updateHomeworkPublishState
    // ignores it whenever publish is false), so only validate it on an
    // actual publish -- an unpublish must never 400 on a re-sent,
    // already-past releasedAt from the loaded form state.
    releasedAt = new Date(body.releasedAt);
    if (Number.isNaN(releasedAt.getTime())) {
      return yield* new BadRequest({ message: "releasedAt must be a valid date" });
    }
    if (releasedAt.getTime() < Date.now()) {
      return yield* new BadRequest({ message: "Release time must be in the future" });
    }
  }

  const scope = courseScopeFromAuthContext(authContext, courseId);
  if (!scope) return yield* new Forbidden({ message: "Course access denied" });

  // #94: unpublishing (publish=false) a homework that already has student
  // activity (conversations against its sections) needs an explicit
  // confirm -- surfaced here, before the write, so a careless unpublish
  // doesn't silently proceed. "hides-not-deletes" already holds today
  // (unpublishing only touches the homeworks row); this only adds the
  // missing confirmation gate in front of it.
  let hadExistingActivity: boolean | undefined;
  if (body.publish === false) {
    const existing = yield* query("getHomeworkById", (db) => getHomeworkById(db, scope, homeworkId));
    if (existing?.homework.publishedAt) {
      hadExistingActivity = yield* query(
        "homeworkHasStudentActivity",
        (db) => homeworkHasStudentActivity(db, homeworkId),
      );
      if (hadExistingActivity && body.confirm !== true) {
        // Built directly rather than failed as a Conflict: the client reads
        // `hasStudentActivity` off this body, which Conflict cannot carry.
        return c.json(
          {
            error: "This homework has existing student activity. Pass confirm: true to unpublish anyway.",
            hasStudentActivity: true,
          },
          409,
        );
      }
    }
  }

  const publish = body.publish;
  const updated = yield* query(
    "updateHomeworkPublishState",
    (db) => updateHomeworkPublishState(db, scope, homeworkId, { publish, releasedAt }),
  );
  if (!updated) return yield* homeworkNotFound();

  // Best-effort (#147): an audit-write failure must not fail a
  // publish/unpublish that already succeeded -- mirrors profile.ts's
  // patchProfileHandler pattern.
  yield* query("getOrgScopesForUser", (db) => getOrgScopesForUser(db, authContext.session.userId)).pipe(
    Effect.flatMap((orgScopes) => query("auditBestEffort", (db) => auditBestEffort(db, orgScopes, {
      actorUserId: authContext.session.userId,
      action: publish ? AUDIT_ACTIONS.HOMEWORK_PUBLISHED : AUDIT_ACTIONS.HOMEWORK_UNPUBLISHED,
      targetType: "homework",
      targetId: updated.id,
    }))),
    Effect.catchTag("DatabaseError", (err) => Effect.sync(() => logServerError("publishHomeworkHandler", err.cause))),
  );

  const responseBody: HomeworkPublishResponse = {
    id: updated.id,
    publishedAt: updated.publishedAt?.toISOString() ?? null,
    releasedAt: updated.releasedAt?.toISOString() ?? null,
    ...(hadExistingActivity !== undefined && { hadExistingActivity }),
  };
  return c.json(responseBody);
}));

export const updateHomeworkHideHandler = effectHandler((c) => Effect.gen(function* () {
  const courseId = c.req.param("courseId");
  const homeworkId = c.req.param("homeworkId");
  const authContext = c.get("authContext");

  if (!authContext || !courseId || !authContext.isInstructorOf(courseId)) {
    return yield* new Forbidden({ message: "Instructor access denied" });
  }

  // #211, same guard and same rationale as updateHomeworkHandler above.
  if (!homeworkId || !UUID_RE.test(homeworkId)) {
    return yield* homeworkNotFound();
  }

  const body = yield* readJsonBody<HomeworkHideBody>(c);
  if (typeof body.isHidden !== "boolean") {
    return yield* new BadRequest({ message: "isHidden (boolean) is required" });
  }

  let expiresAt: Date | null | undefined;
  if (body.expiresAt !== undefined) {
    // Same uncontrolled-<input>-sends-"" class of bug as releasedAt (C1/#161
    // pattern) -- normalize an empty string to null (explicit clear) rather
    // than letting `new Date("")` produce an Invalid Date.
    if (body.expiresAt === null || body.expiresAt === "") {
      expiresAt = null;
    } else {
      expiresAt = new Date(body.expiresAt);
      if (Number.isNaN(expiresAt.getTime())) {
        return yield* new BadRequest({ message: "expiresAt must be a valid date or null" });
      }
    }
  }

  const scope = courseScopeFromAuthContext(authContext, courseId);
  if (!scope) return yield* new Forbidden({ message: "Course access denied" });

  const isHidden = body.isHidden;
  const updated = yield* query(
    "updateHomeworkHideState",
    (db) => updateHomeworkHideState(db, scope, homeworkId, { isHidden, expiresAt }),
  );
  if (!updated) return yield* homeworkNotFound();

  // Best-effort (#147), same pattern as publishHomeworkHandler.
  yield* query("getOrgScopesForUser", (db) => getOrgScopesForUser(db, authContext.session.userId)).pipe(
    Effect.flatMap((orgScopes) => query("auditBestEffort", (db) => auditBestEffort(db, orgScopes, {
      actorUserId: authContext.session.userId,
      action: isHidden ? AUDIT_ACTIONS.HOMEWORK_HIDDEN : AUDIT_ACTIONS.HOMEWORK_UNHIDDEN,
      targetType: "homework",
      targetId: updated.id,
    }))),
    Effect.catchTag("DatabaseError", (err) => Effect.sync(() => logServerError("updateHomeworkHideHandler", err.cause))),
  );

  const responseBody: HomeworkHideResponse = {
    id: updated.id,
    isHidden: updated.isHidden,
    expiresAt: updated.expiresAt?.toISOString() ?? null,
  };
  return c.json(responseBody);
}));
