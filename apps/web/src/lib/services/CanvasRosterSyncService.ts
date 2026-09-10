/* --------------------------------------------------------------------------
   #74: syncing a course's roster from Canvas.

   Fetch-then-write, always -- every enrollment page is pulled and held in
   memory (canvas-api.ts's fetchAllPages) before any write starts, so a
   mid-fetch failure (pagination error, revoked token, exhausted rate-limit
   retries) leaves the roster completely untouched rather than half-synced.
   The route layer is what marks lms_integrations as "error" when this
   throws; this module never writes a partial result.

   Three write passes, diffed on courseMemberships.canvasEnrollmentId --
   see docs/superpowers/plans/2026-09-10-m11-canvas-integration.md's
   "Design decisions" #4 for the full reasoning, restated briefly at each
   pass below:

     A. KNOWN rows (canvasEnrollmentId already on a membership here) ->
        direct role/canvasRole update, restoring if previously dropped by
        THIS mechanism. Canvas is authoritative for a row it already owns,
        so this bypasses upsertCourseMembers' deliberate "don't auto-
        promote a role conflict" refusal -- that refusal protects a
        MANUALLY curated membership, which this is not.
     B. NEW-to-Canvas rows -> resolved by email through
        roster.ts's upsertCourseMembers (the one provisioning pipeline --
        see that file's own header), then canvasEnrollmentId/canvasRole
        stamped onto whatever membership it resolved to. A genuine
        role_conflict here (Canvas says one role, an existing MANUALLY
        added active membership says another) is reported as a per-row
        error, not silently overridden -- the same refusal, this time
        correctly protecting a manually curated row.
     C. REMOVED rows -- active, canvasEnrollmentId set, not present in
        this sync's enrollment set -- soft-dropped with
        droppedReason "roster_removal", the same enum value roster.ts's
        manual removal already uses.
   -------------------------------------------------------------------------- */

import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "../../db/client";
import { courseMemberships } from "../../db/schema";
import type { CourseScope } from "../../server/repositories/scope";
import { allowedDomainsForCourse, upsertCourseMembers, type CourseRole } from "../../server/repositories/roster";
import { listCanvasEnrollments, type CanvasEnrollmentType } from "../canvas-api";
import type { IdentityCipher } from "../crypto/identity-cipher";

/** #74's role mapping table (Design decision #5). Kept here, once, rather
 *  than re-derived at any call site. */
const CANVAS_ROLE_MAP: Partial<Record<CanvasEnrollmentType, CourseRole>> = {
  TeacherEnrollment: "instructor",
  TaEnrollment: "ta",
  StudentEnrollment: "student",
  ObserverEnrollment: "observer",
  // No direct llteacher equivalent for a content-authoring, non-grading
  // Canvas role; instructor is the closest available authority tier.
  DesignerEnrollment: "instructor",
};

export interface CanvasSyncCounts {
  added: number;
  updated: number;
  removed: number;
}

export interface CanvasSyncRowError {
  canvasEnrollmentId: string;
  message: string;
}

export interface CanvasSyncResult extends CanvasSyncCounts {
  errors: CanvasSyncRowError[];
}

export async function syncCanvasRoster(
  db: Db,
  cipher: IdentityCipher,
  scope: CourseScope,
  canvasCourseId: string,
  credential: { token: string; canvasBaseUrl: string },
): Promise<CanvasSyncResult> {
  // ---- Fetch phase: everything or nothing reaches the writes below. ----
  const enrollments = await listCanvasEnrollments(
    credential.canvasBaseUrl,
    credential.token,
    canvasCourseId,
  );

  const errors: CanvasSyncRowError[] = [];
  const mapped: { canvasEnrollmentId: string; canvasRole: string; email: string; displayName?: string; role: CourseRole }[] = [];
  for (const e of enrollments) {
    const role = CANVAS_ROLE_MAP[e.type];
    if (!role) {
      errors.push({
        canvasEnrollmentId: e.canvasEnrollmentId,
        message: `Skipped: "${e.type}" has no equivalent role in this app.`,
      });
      continue;
    }
    if (!e.email) {
      errors.push({
        canvasEnrollmentId: e.canvasEnrollmentId,
        message: "Skipped: this Canvas enrollment has no email address on file.",
      });
      continue;
    }
    mapped.push({
      canvasEnrollmentId: e.canvasEnrollmentId,
      canvasRole: e.type,
      email: e.email,
      displayName: e.name ?? undefined,
      role,
    });
  }

  // ---- Pass A: rows this sync already owns. ----
  const incomingIds = mapped.map((m) => m.canvasEnrollmentId);
  const knownRows =
    incomingIds.length > 0
      ? await db
          .select({ id: courseMemberships.id, canvasEnrollmentId: courseMemberships.canvasEnrollmentId })
          .from(courseMemberships)
          .where(
            and(eq(courseMemberships.courseId, scope), inArray(courseMemberships.canvasEnrollmentId, incomingIds)),
          )
      : [];
  const knownByCanvasId = new Map(knownRows.map((r) => [r.canvasEnrollmentId!, r.id]));

  let updated = 0;
  for (const m of mapped) {
    const membershipId = knownByCanvasId.get(m.canvasEnrollmentId);
    if (!membershipId) continue;
    try {
      await db
        .update(courseMemberships)
        .set({
          role: m.role,
          canvasRole: m.canvasRole,
          droppedAt: null,
          droppedReason: null,
          lastSyncedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(courseMemberships.id, membershipId));
      updated++;
    } catch (err) {
      errors.push({ canvasEnrollmentId: m.canvasEnrollmentId, message: describeError(err) });
    }
  }

  // ---- Pass B: rows new to this sync -- resolved through the one shared
  // provisioning pipeline, then stamped with their Canvas identity. ----
  const newToCanvas = mapped.filter((m) => !knownByCanvasId.has(m.canvasEnrollmentId));
  let added = 0;
  if (newToCanvas.length > 0) {
    const allowedDomains = await allowedDomainsForCourse(db, scope);
    const results = await upsertCourseMembers(
      db,
      scope,
      cipher,
      newToCanvas.map((m) => ({ email: m.email, displayName: m.displayName, role: m.role })),
      allowedDomains,
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      const source = newToCanvas[i]!;
      if (result.status === "added" || result.status === "restored" || result.status === "already_enrolled") {
        if (!result.membershipId) continue;
        try {
          await db
            .update(courseMemberships)
            .set({
              canvasEnrollmentId: source.canvasEnrollmentId,
              canvasRole: source.canvasRole,
              lastSyncedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(courseMemberships.id, result.membershipId));
          if (result.status === "added") added++;
          else updated++;
        } catch (err) {
          errors.push({ canvasEnrollmentId: source.canvasEnrollmentId, message: describeError(err) });
        }
        continue;
      }
      // invalid_email / disallowed_domain / role_conflict: a real, reportable
      // outcome, not a sync bug -- see this module's own header on why
      // role_conflict here is deliberately NOT auto-resolved.
      errors.push({
        canvasEnrollmentId: source.canvasEnrollmentId,
        message: result.message ?? `Could not enroll ${source.email} (${result.status}).`,
      });
    }
  }

  // ---- Pass C: rows this sync no longer sees. ----
  // Deliberately NOT scoped to `knownRows` from Pass A above -- that set is
  // exactly the rows THIS round's incoming enrollments matched, i.e. the
  // ones that must NOT be removed. What this pass needs is every row ANY
  // prior sync stamped with a canvasEnrollmentId (isNotNull, not "was in
  // this round"), so a person present in a previous sync but absent from
  // this one is actually caught as a removal. `isNotNull` also excludes
  // never-synced rows -- a manually added member Canvas has simply never
  // heard of is not this pass's business to drop.
  const incomingIdSet = new Set(incomingIds);
  const activeCanvasMemberships = await db
    .select({ id: courseMemberships.id, canvasEnrollmentId: courseMemberships.canvasEnrollmentId })
    .from(courseMemberships)
    .where(
      and(
        eq(courseMemberships.courseId, scope),
        isNull(courseMemberships.droppedAt),
        isNotNull(courseMemberships.canvasEnrollmentId),
      ),
    );
  const toRemoveIds = activeCanvasMemberships
    .filter((r) => !incomingIdSet.has(r.canvasEnrollmentId!))
    .map((r) => r.id);

  let removed = 0;
  if (toRemoveIds.length > 0) {
    await db
      .update(courseMemberships)
      .set({
        droppedAt: new Date(),
        droppedReason: "roster_removal",
        canViewSolutions: false,
        canViewDrafts: false,
        updatedAt: new Date(),
      })
      .where(and(eq(courseMemberships.courseId, scope), inArray(courseMemberships.id, toRemoveIds)));
    removed = toRemoveIds.length;
  }

  return { added, updated, removed, errors };
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : "An unexpected error occurred while writing this row.";
}
