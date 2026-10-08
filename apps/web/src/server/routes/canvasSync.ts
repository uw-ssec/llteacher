/* --------------------------------------------------------------------------
   #74: linking a course to Canvas, and syncing its roster.

   Course-scoped (requireInstructorOf on THIS course), unlike
   canvasCredentials.ts's instructor-scoped token. An instructor can reuse
   one credential across the courses they run, while each course remains
   independently linked and synced.
   -------------------------------------------------------------------------- */

import { type Context } from "hono";
import { Effect } from "effect";
import { loadIdentityCipherKeys } from "../../lib/secrets-loader";
import { IdentityCipher } from "../../lib/crypto/identity-cipher";
import { listCanvasCourses, CanvasApiError, CanvasRateLimitedError } from "../../lib/canvas-api";
import { syncCanvasRoster } from "../../lib/services/CanvasRosterSyncService";
import { getDecryptedCanvasCredential, getDecryptedCanvasCredentialById } from "../repositories/organizationCredentials";
import {
  beginSync,
  getLmsIntegrationForCourse,
  linkCanvasCourse,
  markCourseSynced,
  updateSyncStatus,
} from "../repositories/lmsIntegrations";
import { getOrgScopeForCourse } from "../repositories/organizations";
import { AUDIT_ACTIONS, AUDIT_TARGET_TYPES, auditBestEffort } from "../utils/audit";
import { logServerError } from "../utils/errors";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import type { CourseScope, OrgScope } from "../repositories/scope";
import type { CanvasLinkBody } from "../../shared/types";
import { BadRequest, Conflict, DatabaseError, ExternalServiceError, Forbidden } from "../effect/errors";
import { effectHandler, requireCourseAccess } from "../effect/http";
import { Database, external, query } from "../effect/services";

interface InstructorCourseCtx {
  scope: CourseScope;
  orgScope: OrgScope;
  courseId: string;
  authContext: AuthContext;
}

function instructorCourseScope(
  c: Context<AppEnv>,
): Effect.Effect<InstructorCourseCtx, Forbidden | DatabaseError, Database> {
  return Effect.gen(function* () {
    const denied = () => new Forbidden({ message: "Instructor access denied" });
    const { authContext, courseId, scope } = yield* requireCourseAccess(c, "courseId", "Instructor access denied");
    if (!authContext.isInstructorOf(courseId)) return yield* denied();
    const orgScope = yield* query("getOrgScopeForCourse", (db) => getOrgScopeForCourse(db, courseId));
    if (!orgScope) return yield* denied();
    return { scope, orgScope, courseId, authContext };
  });
}

/** See canvasCredentials.ts's loadCipher: a missing/malformed key is a
 *  deployment fault (defect, generic 503); a stored token that fails to
 *  decrypt surfaces from its repository call as a DatabaseError (503). */
const loadCipher = (env: Env) =>
  Effect.promise(async () => new IdentityCipher(await loadIdentityCipherKeys(env)));

const NO_CREDENTIAL_MESSAGE =
  "Connect your Canvas account first (Canvas Integration settings).";

const noCredential = () => new Conflict({ message: NO_CREDENTIAL_MESSAGE });

/** A Canvas call failed: CanvasApiError/CanvasRateLimitedError when Canvas
 *  answered, ExternalServiceError when it could not be reached at all.
 *  Unwrapped back to what was thrown, for the log line and for
 *  canvasErrorMessage. */
function canvasFailureCause(err: CanvasApiError | ExternalServiceError): unknown {
  return err._tag === "ExternalServiceError" ? err.cause : err;
}

/** #74's course picker / #3's visibility check: every course the org's
 *  stored token's own account can see. A failure is answered here with an
 *  actionable sentence at 503 (the instructor's next step depends on
 *  whether Canvas rejected the token, rate-limited, or was unreachable),
 *  not the generic 503 body. */
function visibleCanvasCourses(
  c: Context<AppEnv>,
  logContext: string,
  credential: { canvasBaseUrl: string; token: string },
) {
  return external(
    "canvas",
    "listCanvasCourses",
    () => listCanvasCourses(credential.canvasBaseUrl, credential.token),
    [CanvasApiError],
  ).pipe(
    Effect.map((courses) => ({ courses })),
    Effect.catch((err) => {
      const cause = canvasFailureCause(err);
      logServerError(logContext, cause);
      return Effect.succeed({ response: c.json({ error: canvasErrorMessage(cause) }, 503) });
    }),
  );
}

/** #74's course picker: every course the org's stored token's own account
 *  can see. */
export const listCanvasCoursesHandler = effectHandler((c) => Effect.gen(function* () {
  const ctx = yield* instructorCourseScope(c);

  const cipher = yield* loadCipher(c.env);
  const credential = yield* query(
    "getDecryptedCanvasCredential",
    (db) => getDecryptedCanvasCredential(db, cipher, ctx.orgScope, ctx.authContext.session.userId),
  );
  if (!credential) return yield* noCredential();

  const listed = yield* visibleCanvasCourses(c, "listCanvasCoursesHandler", credential);
  if ("response" in listed) return listed.response;
  return c.json({ courses: listed.courses });
}));

export const getCanvasSyncStatusHandler = effectHandler((c) => Effect.gen(function* () {
  const ctx = yield* instructorCourseScope(c);

  const integration = yield* query("getLmsIntegrationForCourse", (db) => getLmsIntegrationForCourse(db, ctx.scope));
  return c.json({
    canvasCourseId: integration?.canvasCourseId ?? null,
    canvasCourseName: integration?.canvasCourseName ?? null,
    lastSyncStatus: integration?.lastSyncStatus ?? "idle",
    lastSyncCounts: integration?.lastSyncCounts ?? null,
    lastSyncErrorMessage: integration?.lastSyncErrorMessage ?? null,
    lastSyncedAt: integration?.lastSyncedAt ?? null,
  });
}));

export const linkCanvasCourseHandler = effectHandler((c) => Effect.gen(function* () {
  const ctx = yield* instructorCourseScope(c);

  const body = yield* Effect.tryPromise({
    try: () => c.req.json<CanvasLinkBody>(),
    catch: () => new BadRequest({ message: "Request body must be valid JSON" }),
  });
  const canvasCourseId = typeof body.canvasCourseId === "string" ? body.canvasCourseId.trim() : "";
  if (!canvasCourseId) return yield* new BadRequest({ message: "Choose a Canvas course to link." });

  const cipher = yield* loadCipher(c.env);
  const credential = yield* query(
    "getDecryptedCanvasCredential",
    (db) => getDecryptedCanvasCredential(db, cipher, ctx.orgScope, ctx.authContext.session.userId),
  );
  if (!credential) return yield* noCredential();

  // #3 (security review, PR #457): canvasCourseId arrives from the request
  // body, not from a value this handler itself resolved. The credential is
  // shared org-wide (canvasCredentials.ts's own header), so without this
  // check an instructor of ANY course in the org could supply an arbitrary
  // Canvas course id and pull a colleague's roster -- names, emails, role
  // -- onto their own course. Cross-checking against this same token's own
  // listCanvasCourses() result -- the same list the course picker itself
  // shows -- confirms the id is actually one the token's owner teaches.
  const listed = yield* visibleCanvasCourses(c, "linkCanvasCourseHandler", credential);
  if ("response" in listed) return listed.response;
  const matchedCourse = listed.courses.find((course) => course.canvasCourseId === canvasCourseId);
  if (!matchedCourse) {
    return yield* new Forbidden({ message: "That Canvas course isn't visible to your Canvas account." });
  }

  // #8 (usability review, PR #457): the picker already knows this course's
  // display name -- persisting it here is what lets the linked-course view
  // show it instead of a raw numeric id (see getCanvasSyncStatusHandler).
  const canvasCourseName = matchedCourse.courseCode
    ? `${matchedCourse.name} (${matchedCourse.courseCode})`
    : matchedCourse.name;

  const outcome = yield* query("linkCanvasCourse", (db) =>
    linkCanvasCourse(db, ctx.scope, ctx.orgScope, {
      canvasCourseId,
      canvasCourseName,
      credentialId: credential.id,
    }),
  );
  if (outcome.outcome === "canvas_course_already_linked") {
    return yield* new Conflict({ message: "Another course in your organization is already linked to that Canvas course." });
  }

  yield* auditLmsChange(ctx, AUDIT_ACTIONS.CANVAS_COURSE_LINKED, { canvasCourseId });
  return c.json({ lmsIntegrationId: outcome.lmsIntegrationId, canvasCourseId });
}));

/** #74's "Sync from Canvas" button: fetch-then-write (see
 *  CanvasRosterSyncService's own header), run synchronously within this
 *  request -- there is no background job infrastructure for this yet
 *  (the issue names a scheduled re-sync as optional/future work), so a
 *  large course's sync is bounded by canvas-api.ts's own per-request
 *  timeout and this route's own wall-clock budget, not by a job queue. */
export const syncCanvasCourseHandler = effectHandler((c) => Effect.gen(function* () {
  const ctx = yield* instructorCourseScope(c);

  const integration = yield* query("getLmsIntegrationForCourse", (db) => getLmsIntegrationForCourse(db, ctx.scope));
  if (!integration || !integration.canvasCourseId) {
    return yield* new Conflict({ message: "Link this course to a Canvas course first." });
  }
  const canvasCourseId = integration.canvasCourseId;

  // #6 (reliability/security review, PR #457): claims the "syncing" state
  // atomically before any fetch or write starts -- see beginSync's own
  // header (lmsIntegrations.ts) for why this matters: two overlapping
  // syncs on one course can otherwise have the earlier run's removal pass
  // soft-drop a student the later run just (re-)added.
  const claimed = yield* query("beginSync", (db) => beginSync(db, integration.id));
  if (!claimed) {
    return yield* new Conflict({
      message: "A sync for this course is already running. Wait for it to finish and try again.",
    });
  }

  const cipher = yield* loadCipher(c.env);
  const credential = integration.apiCredentialId
    ? yield* query("getDecryptedCanvasCredentialById", (db) =>
        getDecryptedCanvasCredentialById(
          db,
          cipher,
          ctx.orgScope,
          ctx.authContext.session.userId,
          integration.apiCredentialId!,
        ))
    : null;
  if (!credential) {
    // Release the "syncing" claim taken above -- without this, a course
    // that loses its credential between linking and syncing would stay
    // permanently locked out of ever syncing again.
    yield* query("updateSyncStatus", (db) =>
      updateSyncStatus(db, integration.id, { status: "error", errorMessage: NO_CREDENTIAL_MESSAGE }),
    );
    return yield* noCredential();
  }

  // The roster sync reads Canvas and writes memberships in one call, so it
  // runs as one Canvas-labelled dependency against the request's database.
  // Every failure inside it -- Canvas refusing, Canvas unreachable, or a
  // write failing partway -- is reported the way it always was: the claim
  // is released as "error", the failure audited, and a 502 with an
  // actionable sentence returned.
  const rosterDb = yield* Database;
  const synced = yield* external(
    "canvas",
    "syncCanvasRoster",
    () => syncCanvasRoster(rosterDb, cipher, ctx.scope, canvasCourseId, credential),
    [CanvasApiError],
  ).pipe(
    Effect.map((result) => ({ result })),
    Effect.catch((err) =>
      Effect.gen(function* () {
        const cause = canvasFailureCause(err);
        const message = canvasErrorMessage(cause);
        yield* query("updateSyncStatus", (db) =>
          updateSyncStatus(db, integration.id, { status: "error", errorMessage: message }),
        );
        yield* auditLmsChange(ctx, AUDIT_ACTIONS.CANVAS_SYNC_FAILED, { message });
        logServerError("syncCanvasCourseHandler", cause);
        return { response: c.json({ error: message }, 502) };
      }),
    ),
  );
  if ("response" in synced) return synced.response;
  const { result } = synced;

  // Recording the outcome happens after the roster is already written, so
  // a failure here is a DatabaseError (503), not a failed sync: reporting it
  // as "Could not reach Canvas" and marking the run "error" would tell the
  // instructor the roster did not change when it did.
  yield* query("updateSyncStatus", (db) =>
    updateSyncStatus(db, integration.id, {
      status: "success",
      counts: { added: result.added, updated: result.updated, removed: result.removed },
      errorMessage:
        result.errors.length > 0
          ? `${result.errors.length} enrollment${result.errors.length === 1 ? "" : "s"} could not be synced. See details below.`
          : undefined,
    }),
  );
  yield* query("markCourseSynced", (db) => markCourseSynced(db, ctx.scope));
  yield* auditLmsChange(ctx, AUDIT_ACTIONS.CANVAS_SYNC_COMPLETED, {
    added: result.added,
    updated: result.updated,
    removed: result.removed,
    errorCount: result.errors.length,
  });
  return c.json(result);
}));

function canvasErrorMessage(err: unknown): string {
  // #11 (compatibility review, PR #457): checked BEFORE the generic
  // CanvasApiError branch below, and matters now that isRateLimited
  // (canvas-api.ts) actually detects 429 -- CanvasRateLimitedError can
  // carry status 403 on an older Canvas instance too, which would
  // otherwise fall into the "rejected token" branch and tell an
  // instructor to replace a token that's working fine.
  if (err instanceof CanvasRateLimitedError) {
    return "Canvas is rate-limiting this request. Wait a moment and try again.";
  }
  if (err instanceof CanvasApiError) {
    return err.status === 401 || err.status === 403
      ? "Canvas rejected this token. It may have expired or been revoked -- check Canvas Integration settings."
      : "Canvas could not complete this request. Try again shortly.";
  }
  return "Could not reach Canvas. Check the instance URL and try again.";
}

/** Best-effort (#147), scoped to the course's org -- a sync/link event
 *  concerns the whole org's view of this course's roster, same tier as
 *  ROSTER_IMPORTED. A DatabaseError here is logged and swallowed. */
function auditLmsChange(
  ctx: InstructorCourseCtx,
  action: string,
  metadata: Record<string, unknown>,
): Effect.Effect<void, never, Database> {
  return query("auditBestEffort", (db) =>
    auditBestEffort(db, [ctx.orgScope], {
      actorUserId: ctx.authContext.session.userId,
      action,
      targetType: AUDIT_TARGET_TYPES.LMS_INTEGRATION,
      targetId: ctx.courseId,
      requestMetadata: metadata,
    }),
  ).pipe(Effect.catchTag("DatabaseError", (err) => Effect.sync(() => logServerError("auditLmsChange", err.cause))));
}
