/* --------------------------------------------------------------------------
   #74: the per-course Canvas connection -- which Canvas course an
   llteacher course is linked to, and the status of its last sync.

   "Linking" writes two things atomically from the caller's point of view
   (two statements, not a transaction -- neon-http has no interactive
   transactions, the same constraint every other multi-statement repository
   here documents): courses.canvas_course_id (already unique per org) and
   an lms_integrations row (courseId unique) pointing at the org's Canvas
   credential. A partial failure between them leaves courses.canvas_course_id
   set but no lms_integrations row -- the next link attempt's upsert
   recovers cleanly either way, since both writes are themselves upserts.
   -------------------------------------------------------------------------- */

import { and, eq, ne } from "drizzle-orm";
import type { Db } from "../../db/client";
import { courses, lmsIntegrations } from "../../db/schema";
import type { CourseScope } from "./scope";

export type LmsSyncStatus = (typeof lmsIntegrations.$inferSelect)["lastSyncStatus"];

export interface LmsIntegrationRow {
  id: string;
  canvasCourseId: string | null;
  apiCredentialId: string | null;
  lastSyncStatus: LmsSyncStatus;
  lastSyncCounts: { added: number; updated: number; removed: number } | null;
  lastSyncErrorMessage: string | null;
  lastSyncedAt: string | null;
}

export async function getLmsIntegrationForCourse(
  db: Db,
  scope: CourseScope,
): Promise<LmsIntegrationRow | null> {
  const [row] = await db
    .select({
      id: lmsIntegrations.id,
      apiCredentialId: lmsIntegrations.apiCredentialId,
      lastSyncStatus: lmsIntegrations.lastSyncStatus,
      lastSyncCounts: lmsIntegrations.lastSyncCounts,
      lastSyncErrorMessage: lmsIntegrations.lastSyncErrorMessage,
      canvasCourseId: courses.canvasCourseId,
      lastSyncedAt: courses.lastSyncedAt,
    })
    .from(lmsIntegrations)
    .innerJoin(courses, eq(lmsIntegrations.courseId, courses.id))
    .where(eq(lmsIntegrations.courseId, scope));
  if (!row) return null;
  return {
    ...row,
    lastSyncedAt: row.lastSyncedAt ? row.lastSyncedAt.toISOString() : null,
  };
}

export type LinkCanvasCourseOutcome =
  | { outcome: "linked"; lmsIntegrationId: string }
  | { outcome: "canvas_course_already_linked" };

/** Points this llteacher course at a Canvas course id, using the org's
 *  current Canvas credential. Idempotent: re-linking the same course
 *  (e.g. to pick a different Canvas course, or after the credential was
 *  rotated) updates the existing row rather than erroring. */
export async function linkCanvasCourse(
  db: Db,
  scope: CourseScope,
  orgId: string,
  input: { canvasCourseId: string; credentialId: string },
): Promise<LinkCanvasCourseOutcome> {
  // courses_org_canvas_course_uq is per-organization: refuse before writing
  // if a DIFFERENT course in this org already claims this Canvas course id,
  // so the instructor gets a sentence instead of a constraint-violation 503.
  const conflict = await db.query.courses.findFirst({
    where: and(
      eq(courses.organizationId, orgId),
      eq(courses.canvasCourseId, input.canvasCourseId),
      ne(courses.id, scope),
    ),
    columns: { id: true },
  });
  if (conflict) return { outcome: "canvas_course_already_linked" };

  await db
    .update(courses)
    .set({ canvasCourseId: input.canvasCourseId, updatedAt: new Date() })
    .where(eq(courses.id, scope));

  const [row] = await db
    .insert(lmsIntegrations)
    .values({
      courseId: scope,
      provider: "canvas",
      apiCredentialId: input.credentialId,
      lastSyncStatus: "idle",
    })
    .onConflictDoUpdate({
      target: lmsIntegrations.courseId,
      set: { apiCredentialId: input.credentialId, updatedAt: new Date() },
    })
    .returning({ id: lmsIntegrations.id });

  return { outcome: "linked", lmsIntegrationId: row!.id };
}

/** Sync status transitions (#74's "last sync time, counts, errors" UI).
 *  `counts`/`errorMessage` are cleared on every write that doesn't supply
 *  them -- a "syncing" transition must not leave a stale error from the
 *  previous run visible while a new one is in flight. */
export async function updateSyncStatus(
  db: Db,
  lmsIntegrationId: string,
  patch: {
    status: LmsSyncStatus;
    counts?: { added: number; updated: number; removed: number };
    errorMessage?: string;
  },
): Promise<void> {
  await db
    .update(lmsIntegrations)
    .set({
      lastSyncStatus: patch.status,
      lastSyncCounts: patch.counts ?? null,
      lastSyncErrorMessage: patch.errorMessage ?? null,
      updatedAt: new Date(),
    })
    .where(eq(lmsIntegrations.id, lmsIntegrationId));
}

/** Stamped separately from updateSyncStatus's other fields -- courses.
 *  lastSyncedAt (not lms_integrations) is the pre-existing column every
 *  other Canvas-projection field (courses.canvasCourseId,
 *  course_memberships.canvasEnrollmentId) already keys freshness off of,
 *  so a successful sync updates it here rather than adding a second,
 *  competing "when was this last synced" column on lms_integrations. */
export async function markCourseSynced(db: Db, scope: CourseScope): Promise<void> {
  await db.update(courses).set({ lastSyncedAt: new Date() }).where(eq(courses.id, scope));
}
