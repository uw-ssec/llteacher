import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { courseMemberships, courses, organizationMemberships, organizations, users } from "../../db/schema";
import { unsafeOrgScope, type OrgScope } from "./scope";
import type { BlindIndex } from "../../db/types/encrypted";
import { IdentityCipher } from "../../lib/crypto/identity-cipher";
import { DomainAllowlistService } from "../../lib/services/DomainAllowlistService";
import { findOrCreatePendingUser } from "./roster";

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
/** #367: the organizations this user is an Org Admin of. Runs beside
 *  listMembershipsForUser on every authenticated request (rolesMiddleware),
 *  so it projects one column and nothing else, for the same reason that
 *  function does (#172 CMP-001). */
export async function listOrgAdminOrgIdsForUser(db: Db, userId: string): Promise<string[]> {
  // The relational builder, like listMembershipsForUser beside it.
  const rows = await db.query.organizationMemberships.findMany({
    where: and(eq(organizationMemberships.userId, userId), eq(organizationMemberships.role, "admin")),
    columns: { organizationId: true },
  });
  return rows.map((r) => r.organizationId);
}

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
/** emailBlindIndex and platformInstructorGrantedAt are projected alongside
 *  isActive/sessionEpoch (rather than a second/third query) so
 *  rolesMiddleware can check super-admin (#316, SuperAdminService) and
 *  platform-instructor (#316, grantPlatformInstructor below) status on the
 *  same per-request round trip.
 *
 *  Explicit return type: BlindIndex is a branded type from a private
 *  symbol, so without this annotation, tsc's inferred return type cannot be
 *  named by any importer of this exported function (TS4058). */
export async function getUserActivationState(
  db: Db,
  userId: string,
): Promise<
  | {
      isActive: boolean;
      sessionEpoch: number;
      emailBlindIndex: BlindIndex;
      platformInstructorGrantedAt: Date | null;
    }
  | undefined
> {
  return db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: {
      isActive: true,
      sessionEpoch: true,
      emailBlindIndex: true,
      platformInstructorGrantedAt: true,
    },
  });
}

/** #316: grants (or re-confirms) courseless, platform-wide "recognized as
 *  an instructor" status -- see the users schema's own doc comment for why
 *  this is columns on the row rather than a course_memberships row or an
 *  audit_events entry. Reuses findOrCreatePendingUser (roster.ts), the same
 *  "find or create a pending user by email" pipeline upsertCourseMember
 *  uses, so a never-logged-in person can be granted this exactly like they
 *  can be added to a course.
 *
 *  Domain-validated against the deployment's singleton organization, or the
 *  configured bootstrap domains before that organization exists.
 *
 *  Idempotent: granting an already-granted user updates grantedBy/grantedAt
 *  to this call rather than erroring, so re-running it is never a mistake. */
export type GrantPlatformInstructorResult =
  | { status: "granted"; userId: string; grantedAt: Date }
  | { status: "invalid_email" | "disallowed_domain"; message: string };

export async function allowedDomainsForPlatformInstructor(
  db: Db,
  bootstrapDomains?: string,
): Promise<string[]> {
  const organization = await db.query.organizations.findFirst({
    where: eq(organizations.deploymentSingleton, true),
    columns: { allowedDomains: true },
  });
  return organization?.allowedDomains
    ?? DomainAllowlistService.bootstrapAllowedDomains(bootstrapDomains);
}

export async function grantPlatformInstructor(
  db: Db,
  cipher: IdentityCipher,
  granterUserId: string,
  rawEmail: string,
  bootstrapDomains?: string,
): Promise<GrantPlatformInstructorResult> {
  const email = IdentityCipher.normalizeEmail(rawEmail);
  const allowedDomains = await allowedDomainsForPlatformInstructor(db, bootstrapDomains);
  const domainCheck = DomainAllowlistService.validateEmailDomain(
    email,
    allowedDomains,
  );
  if (!domainCheck.allowed) {
    const malformed = domainCheck.reason === "Invalid email format";
    return {
      status: malformed ? "invalid_email" : "disallowed_domain",
      message: domainCheck.reason ?? "That email address is not eligible.",
    };
  }

  const user = await findOrCreatePendingUser(db, cipher, email);
  const grantedAt = new Date();
  await db
    .update(users)
    .set({ platformInstructorGrantedAt: grantedAt, platformInstructorGrantedBy: granterUserId })
    .where(eq(users.id, user.id));

  return { status: "granted", userId: user.id, grantedAt };
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

/* -- #367: Org Admin grants ------------------------------------------------ */

export type GrantOrgAdminResult =
  | { status: "granted"; userId: string }
  | { status: "invalid_email" | "disallowed_domain"; message: string };

/** Grants Org Admin in one organization, by email. Same identity path as
 *  grantPlatformInstructor: the domain allowlist, then findOrCreatePendingUser
 *  so a grant can precede the person's first login (they claim the pending
 *  row by email blind index on sign-in). Idempotent: granting twice is one
 *  row. */
export async function grantOrgAdmin(
  db: Db,
  cipher: IdentityCipher,
  granterUserId: string,
  organizationId: string,
  rawEmail: string,
): Promise<GrantOrgAdminResult> {
  const email = IdentityCipher.normalizeEmail(rawEmail);
  const domainCheck = DomainAllowlistService.validateEmailDomain(
    email,
    DomainAllowlistService.DEFAULT_ALLOWED_DOMAINS,
  );
  if (!domainCheck.allowed) {
    const malformed = domainCheck.reason === "Invalid email format";
    return {
      status: malformed ? "invalid_email" : "disallowed_domain",
      message: domainCheck.reason ?? "That email address is not eligible.",
    };
  }
  const user = await findOrCreatePendingUser(db, cipher, email);
  await db
    .insert(organizationMemberships)
    .values({ userId: user.id, organizationId, role: "admin", grantedByUserId: granterUserId })
    .onConflictDoNothing({ target: [organizationMemberships.userId, organizationMemberships.organizationId] });
  return { status: "granted", userId: user.id };
}

/** Revokes Org Admin in one organization. False when there was no grant. */
export async function revokeOrgAdmin(db: Db, organizationId: string, userId: string): Promise<boolean> {
  const removed = await db
    .delete(organizationMemberships)
    .where(and(eq(organizationMemberships.organizationId, organizationId), eq(organizationMemberships.userId, userId)))
    .returning({ id: organizationMemberships.id });
  return removed.length > 0;
}

/** The organization's Org Admins, emails decrypted for display. */
export async function listOrgAdmins(
  db: Db,
  cipher: IdentityCipher,
  organizationId: string,
): Promise<{ userId: string; email: string; grantedAt: string }[]> {
  const rows = await db
    .select({ userId: organizationMemberships.userId, email: users.email, grantedAt: organizationMemberships.createdAt })
    .from(organizationMemberships)
    .innerJoin(users, eq(organizationMemberships.userId, users.id))
    .where(and(eq(organizationMemberships.organizationId, organizationId), eq(organizationMemberships.role, "admin")))
    .orderBy(organizationMemberships.createdAt);
  const out = [];
  for (const r of rows) {
    out.push({ userId: r.userId, email: await cipher.decryptString(r.email), grantedAt: r.grantedAt.toISOString() });
  }
  return out;
}
