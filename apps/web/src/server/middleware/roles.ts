import type { Context, Next } from "hono";
import { Effect } from "effect";
import { courseMemberships, courseRoleEnum } from "../../db/schema";
import { listMembershipsForUser, listOrgAdminOrgIdsForUser, getUserActivationState } from "../repositories/users";
import type { SessionPayload } from "../../lib/session";
import type { AppEnv } from "../context";
import {
  AUTHOR_ROLES,
  GRADER_ROLES,
  resolveTaCapabilities,
  type TaCapabilityField,
} from "@llteacher/ui/auth/courseRole";
import { PUBLIC_API_PATHS } from "./auth";
import { IdentityCipher } from "../../lib/crypto/identity-cipher";
import { loadIdentityCipherKeys } from "../../lib/secrets-loader";
import { SuperAdminService } from "../../lib/services/SuperAdminService";
import { runEffect } from "../effect/http";
import { query } from "../effect/services";

// Re-exported for server/testing/authContext.ts, which must derive its
// predicates from the same tiers rolesMiddleware uses. @llteacher/ui remains
// the definition; server code needing the tiers directly (ProfileService,
// courseRoleParity.test.ts) imports from there.
//
// #200 (#172 re-audit, MNT-024): an earlier version of this comment named
// `guards` as a consumer and claimed the re-export gave server callers "one
// import path". Neither was true -- guards.ts imports no tier at all (it
// calls authContext.isInstructorOf/isGraderOf), and two other server files
// import straight from @llteacher/ui. The risk was specific: a future guard
// author reads it and adds a guards.ts -> middleware/roles.ts edge that
// exists only because the comment said it should.
export { AUTHOR_ROLES, GRADER_ROLES };

export type CourseRole = (typeof courseRoleEnum.enumValues)[number];
/** Exactly what listMembershipsForUser projects, and therefore exactly what
 *  AuthContext can honestly offer. Previously `$inferSelect` (the full row),
 *  which advertised columns the query no longer fetches -- a consumer
 *  reading `enrolledAt` off this would have compiled and then read
 *  undefined at runtime. */
type Membership = Pick<
  typeof courseMemberships.$inferSelect,
  "id" | "userId" | "courseId" | "role" | "canViewSolutions" | "canViewDrafts"
>;

export interface AuthContext {
  session: SessionPayload;
  memberships: Membership[];
  /** #316: this session's email is one of SuperAdminService's configured
   *  addresses. Full elevated access everywhere -- see the course-scoped
   *  predicates below, every one of which short-circuits true for a super
   *  admin regardless of `memberships`. Deliberately NOT consulted by
   *  hasRole: that gates student-action routes (requireRole(["student"])),
   *  and a super admin impersonating a student is out of scope. */
  isSuperAdmin: boolean;
  /** #316: this session's users row has a non-null
   *  platformInstructorGrantedAt -- a courseless, platform-wide "recognized
   *  as an instructor" grant. Deliberately NARROW, unlike isSuperAdmin:
   *  this does NOT widen isMemberOf/isInstructorOf/etc. It only lets the
   *  console admit the person (see apps/admin's own console-wide gate)
   *  instead of showing <Forbidden> before they hold any real course
   *  membership. Course authority still comes only from a real
   *  course_memberships row -- granting this does not make someone an
   *  instructor of any specific course, on its own. */
  isPlatformInstructor: boolean;
  /** #367: organizations this user holds an Org Admin grant in
   *  (organization_memberships). Not widened by isSuperAdmin -- read
   *  isOrgAdminOf for the authority question. */
  orgAdminOrgIds: readonly string[];
  hasRole(role: CourseRole): boolean;
  isMemberOf(courseId: string): boolean;
  /** Authoring authority: create/edit/delete/publish/hide course content. */
  isInstructorOf(courseId: string): boolean;
  /** Grading authority: read student work. Strictly wider than
   *  isInstructorOf -- every instructor is a grader, not every grader is an
   *  instructor. */
  isGraderOf(courseId: string): boolean;
  /** #172: instructors/admins always; a TA only where the instructor granted
   *  it on that specific membership; nobody else. Solutions are the answer
   *  key, so this stays opt-in per course rather than implied by the role. */
  canViewSolutionsIn(courseId: string): boolean;
  /** #172: same shape as canViewSolutionsIn, for draft/scheduled/hidden
   *  homeworks -- content the instructor has not released to students. */
  canViewDraftsIn(courseId: string): boolean;
  /** #367: org-level authority -- the shared LLM config pool and the org
   *  default. Org-keyed, unlike every predicate above: being an instructor
   *  of a course in the organization does NOT imply it. A super admin holds
   *  it everywhere, matching the course predicates. */
  isOrgAdminOf(organizationId: string): boolean;
}

/** Loads course_memberships once per request (not per guard) and attaches
 *  role-check helpers to the context. No-ops when authMiddleware found no
 *  session -- that case is already a 401 for protected routes -- and on
 *  PUBLIC_API_PATHS, where roles are meaningless (most importantly logout,
 *  which must be able to clear the session cookie even if the database is
 *  down).
 *
 *  Also enforces session revocation (#95): the sealed cookie is
 *  cryptographically valid on its own, but that only proves it hasn't been
 *  tampered with -- it says nothing about whether the account has since
 *  been deprovisioned. Piggybacks the isActive/sessionEpoch check onto this
 *  same per-request DB round-trip (parallel with the membership query, not
 *  a second sequential one) rather than adding it to authMiddleware, which
 *  stays purely cookie-based. */
export async function rolesMiddleware(c: Context<AppEnv>, next: Next) {
  const session = c.get("session");
  if (!session || PUBLIC_API_PATHS.has(c.req.path)) {
    await next();
    return;
  }

  // Typed so a database outage here is classified and logged like any
  // handler's (effect/http.ts), rather than reaching app.onError untyped.
  // `next()` stays outside the Effect: downstream throws keep their own path.
  const loaded = await runEffect(c, Effect.all([
    query("listMembershipsForUser", (db) => listMembershipsForUser(db, session.userId)),
    query("getUserActivationState", (db) => getUserActivationState(db, session.userId)),
    Effect.promise(() => loadIdentityCipherKeys(c.env)),
    query("listOrgAdminOrgIdsForUser", (db) => listOrgAdminOrgIdsForUser(db, session.userId)),
  ], { concurrency: "unbounded" }));
  if (!loaded.ok) return loaded.response;
  const [memberships, activation, cipherKeys, orgAdminOrgIds] = loaded.value;

  // Deprovisioned (isActive=false), or this cookie predates the account's
  // current session_epoch (a WorkOS deprovisioning webhook bumped it since
  // this cookie was issued) -- either way the cookie is cryptographically
  // valid but no longer authorized. Same 401 shape as authMiddleware's "no
  // session" case; the caller can't tell a revoked session from no session
  // at all, which is the point.
  if (!activation || !activation.isActive || activation.sessionEpoch !== session.sessionEpoch) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // #316: super-admin status is a blind-index equality check against
  // SuperAdminService's configured allowlist, never a plaintext compare --
  // users.email is AES-GCM ciphertext, and emailBlindIndex is the
  // deterministic HMAC that exists precisely for this kind of lookup.
  const cipher = new IdentityCipher(cipherKeys);
  const superAdminBlindIndexes = await SuperAdminService.blindIndexes(cipher, c.env.SUPER_ADMIN_EMAILS);
  const isSuperAdmin = SuperAdminService.isSuperAdmin(
    activation.emailBlindIndex,
    superAdminBlindIndexes,
  );
  // #316: no blind-index check needed here -- unlike super-admin status
  // (checked against a hardcoded list of emails), this is a fact about the
  // already-resolved user row itself, already fetched above.
  const isPlatformInstructor = activation.platformInstructorGrantedAt !== null;

  // listMembershipsForUser already filters droppedAt (#139), so every
  // predicate below reads only live memberships -- a dropped TA loses each
  // capability with the membership, without a second check here.
  //
  // Every course-scoped predicate resolves the membership ONCE through this
  // helper and then asks a question about that single row. The alternative --
  // each predicate scanning `memberships` with its own courseId+role
  // condition -- is equivalent only while course_memberships_user_course_uq
  // (db/schema/identity.ts) guarantees at most one row per (user, course).
  // Relax or drop that index and the two styles diverge: a per-predicate
  // `.some()` answers "does ANY row satisfy me" while a capability lookup
  // answers "what does THE row say", so `isInstructorOf` could report true
  // off one row while `canViewSolutionsIn` reads a different one. Resolving
  // once makes every predicate describe the same membership by construction,
  // so they agree regardless of what the index guarantees.
  const membershipIn = (courseId: string) => memberships.find((m) => m.courseId === courseId);

  /** Delegates to @llteacher/ui's resolveTaCapabilities -- the single
   *  definition both this middleware and ProfileService use, so the rule
   *  enforced at request time and the rule shipped to apps/admin cannot
   *  diverge. */
  const capability = (courseId: string, flag: TaCapabilityField) => {
    const membership = membershipIn(courseId);
    if (!membership) return false;
    return resolveTaCapabilities(membership)[flag];
  };

  const roleIn = (courseId: string, allowed: readonly CourseRole[]) => {
    const membership = membershipIn(courseId);
    return membership !== undefined && allowed.includes(membership.role);
  };

  const authContext: AuthContext = {
    session,
    memberships,
    isSuperAdmin,
    isPlatformInstructor,
    orgAdminOrgIds,
    // Not course-scoped: "do I hold this role anywhere" is a genuine
    // any-membership question, so `.some()` is correct here. Deliberately
    // not widened by isSuperAdmin -- see the AuthContext doc comment.
    hasRole: (role) => memberships.some((m) => m.role === role),
    // #316: every course-scoped predicate below short-circuits true for a
    // super admin, regardless of `memberships` -- this is what lets
    // requireInstructorOf/requireGraderOf/requireCourseMember and
    // courseScopeFromAuthContext admit a super admin to a course they hold
    // no real membership on, with no change to guards.ts or any route.
    isMemberOf: (courseId) => isSuperAdmin || membershipIn(courseId) !== undefined,
    isInstructorOf: (courseId) => isSuperAdmin || roleIn(courseId, AUTHOR_ROLES),
    isGraderOf: (courseId) => isSuperAdmin || roleIn(courseId, GRADER_ROLES),
    canViewSolutionsIn: (courseId) => isSuperAdmin || capability(courseId, "canViewSolutions"),
    canViewDraftsIn: (courseId) => isSuperAdmin || capability(courseId, "canViewDrafts"),
    isOrgAdminOf: (organizationId) => isSuperAdmin || orgAdminOrgIds.includes(organizationId),
  };

  c.set("authContext", authContext);
  await next();
}
