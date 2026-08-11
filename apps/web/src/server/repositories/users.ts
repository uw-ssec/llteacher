import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { courseMemberships, courses, users } from "../../db/schema";
import { unsafeOrgScope, type OrgScope } from "./scope";

/** The distinct organizations a user is reachable through via their
 *  (non-dropped) course memberships. Shared by deactivateByWorkosUserId
 *  (#95/#142, audit-logs a deprovisioning against every org the user
 *  belonged to) and the audit-event call sites in routes/auth.ts and
 *  routes/profile.ts (#147, same "which org(s) does this personal action
 *  concern" question for login/logout/profile-update). Returns an empty
 *  array for a user with no active memberships -- callers audit-log
 *  against zero orgs rather than guessing one. */
export async function getOrgScopesForUser(db: Db, userId: string): Promise<OrgScope[]> {
  const orgRows = await db
    .selectDistinct({ organizationId: courses.organizationId })
    .from(courseMemberships)
    .innerJoin(courses, eq(courseMemberships.courseId, courses.id))
    .where(and(eq(courseMemberships.userId, userId), isNull(courseMemberships.droppedAt)));
  return orgRows.map((r) => unsafeOrgScope(r.organizationId));
}

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
  // #172 audit (CMP-001/REL-002): explicitly projected rather than selecting
  // every schema-declared column. rolesMiddleware runs this on EVERY
  // authenticated request, and Drizzle's relational builder emits the column
  // list from the compiled schema -- so any additive column shipped before
  // its migration is applied takes the entire authenticated API down (every
  // user, not just the new feature) with `column ... does not exist`.
  // Naming what AuthContext actually consumes bounds that blast radius to
  // the columns this middleware genuinely depends on.
  return db.query.courseMemberships.findMany({
    where: and(eq(courseMemberships.userId, userId), isNull(courseMemberships.droppedAt)),
    columns: {
      id: true,
      userId: true,
      courseId: true,
      role: true,
      canViewSolutions: true,
      canViewDrafts: true,
    },
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

/** Like getOrgScopesForUser, but also counts a membership dropped
 *  specifically *by this deprovisioning* (droppedReason='user_deprovisioned')
 *  as still "reachable" for audit purposes (#151). Plain getOrgScopesForUser
 *  can't be reused here: deactivateByWorkosUserId's own cascade already
 *  drops those memberships (isNull(droppedAt) stops matching them) before a
 *  retry might need to recompute the same org scopes again. Without this,
 *  a retry after a failed audit write -- the exact scenario #151 fixes --
 *  would see zero org scopes (the first attempt already cascaded them) and
 *  silently lose the audit a second time. A membership dropped for any
 *  *other* reason (droppedReason IS NULL from a future Canvas roster
 *  removal, or 'roster_removal') is correctly excluded either way. */
export async function getOrgScopesForDeprovisioning(db: Db, userId: string): Promise<OrgScope[]> {
  const orgRows = await db
    .selectDistinct({ organizationId: courses.organizationId })
    .from(courseMemberships)
    .innerJoin(courses, eq(courseMemberships.courseId, courses.id))
    .where(
      and(
        eq(courseMemberships.userId, userId),
        or(
          isNull(courseMemberships.droppedAt),
          eq(courseMemberships.droppedReason, "user_deprovisioned"),
        ),
      ),
    );
  return orgRows.map((r) => unsafeOrgScope(r.organizationId));
}

/** The write side of #95: a WorkOS `user.deleted` webhook calls this to
 *  deactivate the app user and revoke every cookie issued before now, while
 *  retaining their PII per #51's retention rules (deactivation, not
 *  erasure). The `isActive = true` guard on the UPDATE's WHERE clause means
 *  a duplicate webhook delivery (WorkOS retries on non-2xx) matches zero
 *  rows on a second attempt, so the state flip itself is idempotent and
 *  never double-bumps sessionEpoch.
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
 *  Returns the deactivated user's id and the distinct organization ids the
 *  caller should audit-log against -- the webhook payload itself carries
 *  no org context, so this is the only way to learn which org(s) care that
 *  this user was deprovisioned. Returns null only when no user matches
 *  workosUserId *at all* (unknown identity, nothing to audit).
 *
 *  #151: deliberately does NOT return null just because the user was
 *  already inactive before this call -- a retry (WorkOS redelivers after a
 *  non-2xx, e.g. because the audit write failed on the first attempt)
 *  needs to still get back the org scopes so the audit can actually be
 *  written this time. Whether this call flipped anything is not something
 *  the caller needs to know; getOrgScopesForDeprovisioning is what makes
 *  the org-scope answer stable across a retry regardless. */
export async function deactivateByWorkosUserId(db: Db, workosUserId: string) {
  const existingUser = await db.query.users.findFirst({
    where: eq(users.workosUserId, workosUserId),
    columns: { id: true },
  });
  if (!existingUser) return null;

  await db
    .update(users)
    .set({ isActive: false, sessionEpoch: sql`${users.sessionEpoch} + 1` })
    .where(and(eq(users.workosUserId, workosUserId), eq(users.isActive, true)));

  // #172 re-audit (SEC-006): the capability grants are revoked with the
  // membership, not carried through it. Two reasons, both concrete:
  //
  //  - listCourseTas filters `droppedAt IS NULL`, so a dropped TA is absent
  //    from the instructor's TA permissions table. Their grant was therefore
  //    invisible AND unrevokable through the product -- the only surface for
  //    revoking it cannot show the row.
  //  - reconcileExisting restores exactly these memberships on the next
  //    successful login. Leaving the flags set meant answer-key access came
  //    back silently, with no instructor action and nothing in the audit log
  //    saying it had been re-granted.
  //
  // Clearing here makes the restore fail closed: the membership returns, the
  // grant does not, and an instructor re-grants deliberately. No backfill
  // migration accompanies this -- both columns are introduced by 0019 in
  // this same branch with DEFAULT false, so no already-dropped row can be
  // carrying a grant.
  await db
    .update(courseMemberships)
    .set({
      droppedAt: sql`now()`,
      droppedReason: "user_deprovisioned",
      canViewSolutions: false,
      canViewDrafts: false,
    })
    .where(and(eq(courseMemberships.userId, existingUser.id), isNull(courseMemberships.droppedAt)));

  const orgScopes = await getOrgScopesForDeprovisioning(db, existingUser.id);

  return {
    userId: existingUser.id,
    orgScopes,
  };
}
