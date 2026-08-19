import { type Context } from "hono";
import { makeDb } from "../../db/client";
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
import { UUID_RE } from "../utils/uuid";
import { AUDIT_ACTIONS, auditBestEffort } from "../utils/audit";
import { logServerError } from "../utils/errors";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import type {
  HomeworkDetailResponse,
  HomeworkHideBody,
  HomeworkHideResponse,
  HomeworkPublishBody,
  HomeworkPublishResponse,
  HomeworkUpdateBody,
  SectionResponse,
} from "../../shared/types";

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
  // #166: instructors continue to see hidden/expired homeworks (labelled as
  // such); students never see them, same gate as draft/scheduled.
  // #172: now keyed on the unreleased-content capability rather than the
  // authoring role, so a TA granted `can_view_drafts` on this course sees
  // them too. Instructors/admins satisfy it unconditionally.
  const visibleRows = authContext!.canViewDraftsIn(courseId!)
    ? rows
    : rows.filter((hw) => !isUnreleased(hw.status));
  return c.json({ homeworks: visibleRows });
}

export async function createHomeworkHandler(c: Context<AppEnv>) {
  const courseId = c.req.param("courseId");
  const authContext = c.get("authContext") as AuthContext | undefined;

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
    return c.json({ error: "Homework not found" }, 404);
  }

  const result = await getHomeworkById(db, scope, homeworkId);
  if (!result) {
    return c.json({ error: "Homework not found" }, 404);
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
  const canEdit = authContext!.isInstructorOf(courseId!);
  const canSeeUnreleased = authContext!.canViewDraftsIn(courseId!);
  const canSeeSolutions = authContext!.canViewSolutionsIn(courseId!);

  const status = deriveHomeworkStatus(result.homework);
  // #166: hidden/expired is the same gate as draft/scheduled for anyone
  // without unreleased-content access -- indistinguishable from not-found,
  // so a guessed/leaked UUID can't confirm a hidden/draft homework is real.
  if (!canSeeUnreleased && isUnreleased(status)) {
    return c.json({ error: "Homework not found" }, 404);
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
    return c.json({ error: "Homework not found" }, 404);
  }

  let body: HomeworkUpdateBody;
  try {
    body = await c.req.json<HomeworkUpdateBody>();
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }

  if (body.sections) {
    for (const section of body.sections) {
      if (typeof section.content === "string" && section.content.length > MAX_SECTION_CONTENT_LENGTH) {
        return c.json(
          { error: `Each section's content must be ${MAX_SECTION_CONTENT_LENGTH} characters or fewer` },
          400,
        );
      }
    }
  }

  let dueDate: Date | undefined;
  if (body.dueDate !== undefined) {
    dueDate = new Date(body.dueDate);
    if (Number.isNaN(dueDate.getTime())) {
      return c.json({ error: "dueDate must be a valid date" }, 400);
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
    return c.json({ error: "llmConfigId must be a valid UUID or null" }, 400);
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

  // #161: the FK on homeworks.llm_config_id only requires the row to exist
  // somewhere, not that it belongs to this course's organization -- without
  // this, an instructor could point a homework at another tenant's llmConfig
  // (and, once M4 resolves credentials through this column, another
  // tenant's provider credentials). Scoped to this course's own org, not
  // every org the caller belongs to -- see getOrgScopeForCourse's docstring.
  if (llmConfigId != null) {
    const courseOrgScope = await getOrgScopeForCourse(db, courseId);
    const belongsToOrg = courseOrgScope ? await llmConfigBelongsToOrg(db, courseOrgScope, llmConfigId) : false;
    if (!belongsToOrg) {
      return c.json({ error: "llmConfigId does not belong to this course's organization" }, 400);
    }
  }

  try {
    const result = await updateHomework(db, scope, homeworkId!, {
      title: body.title,
      description: body.description,
      dueDate,
      llmConfigId,
      sections: body.sections,
      widgets: body.widgets,
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

  // #211, same guard and same rationale as updateHomeworkHandler above.
  if (!homeworkId || !UUID_RE.test(homeworkId)) {
    return c.json({ error: "Homework not found" }, 404);
  }

  const scope = courseScopeFromAuthContext(authContext, courseId);
  if (!scope) return c.json({ error: "Course access denied" }, 403);

  const db = makeDb(c.env.DATABASE_URL);
  const deleted = await deleteHomework(db, scope, homeworkId!);
  if (!deleted) return c.json({ error: "Homework not found" }, 404);
  return c.body(null, 204);
}

export async function publishHomeworkHandler(c: Context<AppEnv>) {
  const courseId = c.req.param("courseId");
  const homeworkId = c.req.param("homeworkId");
  const authContext = c.get("authContext") as AuthContext | undefined;

  if (!authContext || !courseId || !authContext.isInstructorOf(courseId)) {
    return c.json({ error: "Instructor access denied" }, 403);
  }

  // #211, same guard and same rationale as updateHomeworkHandler above.
  if (!homeworkId || !UUID_RE.test(homeworkId)) {
    return c.json({ error: "Homework not found" }, 404);
  }

  let body: HomeworkPublishBody;
  try {
    body = await c.req.json<HomeworkPublishBody>();
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }
  if (typeof body.publish !== "boolean") {
    return c.json({ error: "publish (boolean) is required" }, 400);
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
      return c.json({ error: "releasedAt must be a valid date" }, 400);
    }
    if (releasedAt.getTime() < Date.now()) {
      return c.json({ error: "Release time must be in the future" }, 400);
    }
  }

  const scope = courseScopeFromAuthContext(authContext, courseId);
  if (!scope) return c.json({ error: "Course access denied" }, 403);

  const db = makeDb(c.env.DATABASE_URL);

  // #94: unpublishing (publish=false) a homework that already has student
  // activity (conversations against its sections) needs an explicit
  // confirm -- surfaced here, before the write, so a careless unpublish
  // doesn't silently proceed. "hides-not-deletes" already holds today
  // (unpublishing only touches the homeworks row); this only adds the
  // missing confirmation gate in front of it.
  let hadExistingActivity: boolean | undefined;
  if (body.publish === false) {
    const existing = await getHomeworkById(db, scope, homeworkId!);
    if (existing?.homework.publishedAt) {
      hadExistingActivity = await homeworkHasStudentActivity(db, homeworkId!);
      if (hadExistingActivity && body.confirm !== true) {
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

  const updated = await updateHomeworkPublishState(db, scope, homeworkId!, { publish: body.publish, releasedAt });
  if (!updated) return c.json({ error: "Homework not found" }, 404);

  // Best-effort (#147): an audit-write failure must not fail a
  // publish/unpublish that already succeeded -- mirrors profile.ts's
  // patchProfileHandler pattern.
  try {
    const orgScopes = await getOrgScopesForUser(db, authContext.session.userId);
    await auditBestEffort(db, orgScopes, {
      actorUserId: authContext.session.userId,
      action: body.publish ? AUDIT_ACTIONS.HOMEWORK_PUBLISHED : AUDIT_ACTIONS.HOMEWORK_UNPUBLISHED,
      targetType: "homework",
      targetId: updated.id,
    });
  } catch (err) {
    logServerError("publishHomeworkHandler", err);
  }

  const responseBody: HomeworkPublishResponse = {
    id: updated.id,
    publishedAt: updated.publishedAt?.toISOString() ?? null,
    releasedAt: updated.releasedAt?.toISOString() ?? null,
    ...(hadExistingActivity !== undefined && { hadExistingActivity }),
  };
  return c.json(responseBody);
}

export async function updateHomeworkHideHandler(c: Context<AppEnv>) {
  const courseId = c.req.param("courseId");
  const homeworkId = c.req.param("homeworkId");
  const authContext = c.get("authContext") as AuthContext | undefined;

  if (!authContext || !courseId || !authContext.isInstructorOf(courseId)) {
    return c.json({ error: "Instructor access denied" }, 403);
  }

  // #211, same guard and same rationale as updateHomeworkHandler above.
  if (!homeworkId || !UUID_RE.test(homeworkId)) {
    return c.json({ error: "Homework not found" }, 404);
  }

  let body: HomeworkHideBody;
  try {
    body = await c.req.json<HomeworkHideBody>();
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }
  if (typeof body.isHidden !== "boolean") {
    return c.json({ error: "isHidden (boolean) is required" }, 400);
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
        return c.json({ error: "expiresAt must be a valid date or null" }, 400);
      }
    }
  }

  const scope = courseScopeFromAuthContext(authContext, courseId);
  if (!scope) return c.json({ error: "Course access denied" }, 403);

  const db = makeDb(c.env.DATABASE_URL);
  const updated = await updateHomeworkHideState(db, scope, homeworkId!, { isHidden: body.isHidden, expiresAt });
  if (!updated) return c.json({ error: "Homework not found" }, 404);

  // Best-effort (#147), same pattern as publishHomeworkHandler.
  try {
    const orgScopes = await getOrgScopesForUser(db, authContext.session.userId);
    await auditBestEffort(db, orgScopes, {
      actorUserId: authContext.session.userId,
      action: body.isHidden ? AUDIT_ACTIONS.HOMEWORK_HIDDEN : AUDIT_ACTIONS.HOMEWORK_UNHIDDEN,
      targetType: "homework",
      targetId: updated.id,
    });
  } catch (err) {
    logServerError("updateHomeworkHideHandler", err);
  }

  const responseBody: HomeworkHideResponse = {
    id: updated.id,
    isHidden: updated.isHidden,
    expiresAt: updated.expiresAt?.toISOString() ?? null,
  };
  return c.json(responseBody);
}
