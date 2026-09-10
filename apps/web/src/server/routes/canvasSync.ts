/* --------------------------------------------------------------------------
   #74: linking a course to Canvas, and syncing its roster.

   Course-scoped (requireInstructorOf on THIS course), unlike
   canvasCredentials.ts's org-wide token -- linking and syncing are things
   an instructor does to their own course, even though the token they're
   spent against is shared org-wide. #courseScopeFromAuthContext is the
   sanctioned way to mint that scope from the request's own membership
   check (see repositories/scope.ts).
   -------------------------------------------------------------------------- */

import { type Context } from "hono";
import { makeDb } from "../../db/client";
import { loadIdentityCipherKeys } from "../../lib/secrets-loader";
import { IdentityCipher } from "../../lib/crypto/identity-cipher";
import { listCanvasCourses, CanvasApiError } from "../../lib/canvas-api";
import { syncCanvasRoster } from "../../lib/services/CanvasRosterSyncService";
import { getDecryptedCanvasCredential } from "../repositories/organizationCredentials";
import {
  getLmsIntegrationForCourse,
  linkCanvasCourse,
  markCourseSynced,
  updateSyncStatus,
} from "../repositories/lmsIntegrations";
import { getOrgScopeForCourse } from "../repositories/organizations";
import { courseScopeFromAuthContext } from "../repositories/scope";
import { AUDIT_ACTIONS, AUDIT_TARGET_TYPES, auditBestEffort } from "../utils/audit";
import { logServerError } from "../utils/errors";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import type { CourseScope, OrgScope } from "../repositories/scope";
import type { CanvasLinkBody } from "../../shared/types";

interface InstructorCourseCtx {
  scope: CourseScope;
  orgScope: OrgScope;
  courseId: string;
  authContext: AuthContext;
}

async function instructorCourseScope(c: Context<AppEnv>): Promise<InstructorCourseCtx | null> {
  const courseId = c.req.param("courseId");
  const authContext = c.get("authContext") as AuthContext | undefined;
  if (!authContext || !courseId || !authContext.isInstructorOf(courseId)) return null;
  const scope = courseScopeFromAuthContext(authContext, courseId);
  if (!scope) return null;
  const db = makeDb(c.env.DATABASE_URL);
  const orgScope = await getOrgScopeForCourse(db, courseId);
  return orgScope ? { scope, orgScope, courseId, authContext } : null;
}

const NO_CREDENTIAL_MESSAGE =
  "Set up your organization's Canvas API token first (Canvas Integration settings).";

/** #74's course picker: every course the org's stored token's own account
 *  can see. */
export async function listCanvasCoursesHandler(c: Context<AppEnv>) {
  const ctx = await instructorCourseScope(c);
  if (!ctx) return c.json({ error: "Instructor access denied" }, 403);

  const db = makeDb(c.env.DATABASE_URL);
  const cipher = new IdentityCipher(await loadIdentityCipherKeys(c.env));
  const credential = await getDecryptedCanvasCredential(db, cipher, ctx.orgScope);
  if (!credential) return c.json({ error: NO_CREDENTIAL_MESSAGE }, 409);

  try {
    const courses = await listCanvasCourses(credential.canvasBaseUrl, credential.token);
    return c.json({ courses });
  } catch (err) {
    logServerError("listCanvasCoursesHandler", err);
    return c.json({ error: canvasErrorMessage(err) }, 503);
  }
}

export async function getCanvasSyncStatusHandler(c: Context<AppEnv>) {
  const ctx = await instructorCourseScope(c);
  if (!ctx) return c.json({ error: "Instructor access denied" }, 403);

  const db = makeDb(c.env.DATABASE_URL);
  const integration = await getLmsIntegrationForCourse(db, ctx.scope);
  return c.json({
    canvasCourseId: integration?.canvasCourseId ?? null,
    lastSyncStatus: integration?.lastSyncStatus ?? "idle",
    lastSyncCounts: integration?.lastSyncCounts ?? null,
    lastSyncErrorMessage: integration?.lastSyncErrorMessage ?? null,
    lastSyncedAt: integration?.lastSyncedAt ?? null,
  });
}

export async function linkCanvasCourseHandler(c: Context<AppEnv>) {
  const ctx = await instructorCourseScope(c);
  if (!ctx) return c.json({ error: "Instructor access denied" }, 403);

  let body: CanvasLinkBody;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }
  const canvasCourseId = typeof body.canvasCourseId === "string" ? body.canvasCourseId.trim() : "";
  if (!canvasCourseId) return c.json({ error: "Choose a Canvas course to link." }, 400);

  const db = makeDb(c.env.DATABASE_URL);
  const cipher = new IdentityCipher(await loadIdentityCipherKeys(c.env));
  const credential = await getDecryptedCanvasCredential(db, cipher, ctx.orgScope);
  if (!credential) return c.json({ error: NO_CREDENTIAL_MESSAGE }, 409);

  const outcome = await linkCanvasCourse(db, ctx.scope, ctx.orgScope, {
    canvasCourseId,
    credentialId: credential.id,
  });
  if (outcome.outcome === "canvas_course_already_linked") {
    return c.json(
      { error: "Another course in your organization is already linked to that Canvas course." },
      409,
    );
  }

  await auditLmsChange(c, ctx, AUDIT_ACTIONS.CANVAS_COURSE_LINKED, { canvasCourseId });
  return c.json({ lmsIntegrationId: outcome.lmsIntegrationId, canvasCourseId });
}

/** #74's "Sync from Canvas" button: fetch-then-write (see
 *  CanvasRosterSyncService's own header), run synchronously within this
 *  request -- there is no background job infrastructure for this yet
 *  (the issue names a scheduled re-sync as optional/future work), so a
 *  large course's sync is bounded by canvas-api.ts's own per-request
 *  timeout and this route's own wall-clock budget, not by a job queue. */
export async function syncCanvasCourseHandler(c: Context<AppEnv>) {
  const ctx = await instructorCourseScope(c);
  if (!ctx) return c.json({ error: "Instructor access denied" }, 403);

  const db = makeDb(c.env.DATABASE_URL);
  const integration = await getLmsIntegrationForCourse(db, ctx.scope);
  if (!integration || !integration.canvasCourseId) {
    return c.json({ error: "Link this course to a Canvas course first." }, 409);
  }

  const cipher = new IdentityCipher(await loadIdentityCipherKeys(c.env));
  const credential = await getDecryptedCanvasCredential(db, cipher, ctx.orgScope);
  if (!credential) return c.json({ error: NO_CREDENTIAL_MESSAGE }, 409);

  try {
    const result = await syncCanvasRoster(db, cipher, ctx.scope, integration.canvasCourseId, credential);
    await updateSyncStatus(db, integration.id, {
      status: "success",
      counts: { added: result.added, updated: result.updated, removed: result.removed },
      errorMessage:
        result.errors.length > 0
          ? `${result.errors.length} enrollment${result.errors.length === 1 ? "" : "s"} could not be synced. See details below.`
          : undefined,
    });
    await markCourseSynced(db, ctx.scope);
    await auditLmsChange(c, ctx, AUDIT_ACTIONS.CANVAS_SYNC_COMPLETED, {
      added: result.added,
      updated: result.updated,
      removed: result.removed,
      errorCount: result.errors.length,
    });
    return c.json(result);
  } catch (err) {
    const message = canvasErrorMessage(err);
    await updateSyncStatus(db, integration.id, { status: "error", errorMessage: message });
    await auditLmsChange(c, ctx, AUDIT_ACTIONS.CANVAS_SYNC_FAILED, { message });
    logServerError("syncCanvasCourseHandler", err);
    return c.json({ error: message }, 502);
  }
}

function canvasErrorMessage(err: unknown): string {
  if (err instanceof CanvasApiError) {
    return err.status === 401 || err.status === 403
      ? "Canvas rejected this token. It may have expired or been revoked -- check Canvas Integration settings."
      : "Canvas could not complete this request. Try again shortly.";
  }
  return "Could not reach Canvas. Check the instance URL and try again.";
}

/** Best-effort (#147), scoped to the course's org -- a sync/link event
 *  concerns the whole org's view of this course's roster, same tier as
 *  ROSTER_IMPORTED. */
async function auditLmsChange(
  c: Context<AppEnv>,
  ctx: InstructorCourseCtx,
  action: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    const db = makeDb(c.env.DATABASE_URL);
    await auditBestEffort(db, [ctx.orgScope], {
      actorUserId: ctx.authContext.session.userId,
      action,
      targetType: AUDIT_TARGET_TYPES.LMS_INTEGRATION,
      targetId: ctx.courseId,
      requestMetadata: metadata,
    });
  } catch (err) {
    logServerError("auditLmsChange", err);
  }
}
