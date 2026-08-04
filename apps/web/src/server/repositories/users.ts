import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { courseMemberships, courses, users } from "../../db/schema";
import { unsafeOrgScope } from "./scope";

/** Intentionally takes no OrgScope/CourseScope. This query is how
 *  rolesMiddleware discovers which orgs/courses a user belongs to in the
 *  first place -- it can't be scoped to a tenant it hasn't resolved yet.
 *  Still routed through the repository layer so no route/middleware
 *  imports Drizzle directly, per the convention in apps/web/ARCHITECTURE.md.
 *
 *  Enforced: filters `droppedAt IS NULL`. This is the sole feed into every
 *  AuthContext predicate (`isMemberOf`, `isInstructorOf`, `hasRole`) and,
 *  via `courseScopeFromAuthContext`, every scope-guarded repository call --
 *  a dropped membership (roster removal, e.g. from a future Canvas sync)
 *  must not still count as active access. No `includeDropped` escape hatch
 *  yet since nothing needs one; add it if/when an instructor roster view
 *  needs to see dropped rows too. */
export async function listMembershipsForUser(db: Db, userId: string) {
  return db.query.courseMemberships.findMany({
    where: and(eq(courseMemberships.userId, userId), isNull(courseMemberships.droppedAt)),
  });
}

/** rolesMiddleware's other per-request read (issue #95): sessions are
 *  stateless sealed cookies with no server-side store, so revoking one
 *  user's access before their cookie's natural expiry needs a live value to
 *  compare the cookie's stamped sessionEpoch against. Returns undefined if
 *  the user row no longer exists -- rolesMiddleware treats that the same as
 *  a mismatch (401), not a crash. */
export async function getUserActivationState(db: Db, userId: string) {
  return db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { isActive: true, sessionEpoch: true },
  });
}

/** The write side of #95: a WorkOS `user.deleted` webhook calls this to
 *  deactivate the app user and revoke every cookie issued before now, while
 *  retaining their PII per #51's retention rules (deactivation, not
 *  erasure). Idempotent by construction, not by a dedup table -- the
 *  `isActive = true` guard in the WHERE clause means a duplicate webhook
 *  delivery (WorkOS retries on non-2xx) matches zero rows on the second
 *  attempt and is a harmless no-op, not an error.
 *
 *  Also cascades into course_memberships (#142): every membership still
 *  active at the moment of deactivation is dropped and tagged
 *  droppedReason='user_deprovisioned', distinct from a future Canvas
 *  roster removal (droppedReason='roster_removal' or null). That tag is
 *  what lets UserIdentityService.reconcileExisting's self-healing
 *  reactivation restore only the memberships *this* deactivation dropped,
 *  not ones dropped for an unrelated reason. This is belt-and-suspenders
 *  with rolesMiddleware's isActive/sessionEpoch gate, which already blocks
 *  all API access for a deactivated user before memberships are ever read
 *  -- but leaving the memberships rows themselves untouched would be a
 *  stale/misleading roster state for anything that reads them directly
 *  (e.g. an instructor roster view, or #16 repositories that don't route
 *  through rolesMiddleware).
 *
 *  Returns the deactivated user's id and the distinct organization ids
 *  reachable through their (pre-cascade) course memberships, for the
 *  caller to audit-log against -- the webhook payload itself carries no
 *  org context, so this is the only way to learn which org(s) care that
 *  this user was deprovisioned. Returns null if no active user matched
 *  (already deactivated, or a WorkOS user id we've never seen). */
export async function deactivateByWorkosUserId(db: Db, workosUserId: string) {
  const [deactivated] = await db
    .update(users)
    .set({ isActive: false, sessionEpoch: sql`${users.sessionEpoch} + 1` })
    .where(and(eq(users.workosUserId, workosUserId), eq(users.isActive, true)))
    .returning({ id: users.id });
  if (!deactivated) return null;

  // Capture org scopes from currently-active memberships BEFORE cascading
  // the drop below -- once dropped, this same isNull(droppedAt) predicate
  // would find nothing left to audit against.
  const orgRows = await db
    .selectDistinct({ organizationId: courses.organizationId })
    .from(courseMemberships)
    .innerJoin(courses, eq(courseMemberships.courseId, courses.id))
    .where(and(eq(courseMemberships.userId, deactivated.id), isNull(courseMemberships.droppedAt)));

  await db
    .update(courseMemberships)
    .set({ droppedAt: sql`now()`, droppedReason: "user_deprovisioned" })
    .where(and(eq(courseMemberships.userId, deactivated.id), isNull(courseMemberships.droppedAt)));

  return {
    userId: deactivated.id,
    orgScopes: orgRows.map((r) => unsafeOrgScope(r.organizationId)),
  };
}
