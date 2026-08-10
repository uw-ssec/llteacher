import type { Context, Next } from "hono";
import { makeDb } from "../../db/client";
import { courseMemberships, courseRoleEnum } from "../../db/schema";
import { listMembershipsForUser, getUserActivationState } from "../repositories/users";
import type { SessionPayload } from "../../lib/session";
import type { AppEnv } from "../context";
import { PUBLIC_API_PATHS } from "./auth";

export type CourseRole = (typeof courseRoleEnum.enumValues)[number];
type Membership = typeof courseMemberships.$inferSelect;

/** Roles that may author course content (create/edit/delete/publish/hide a
 *  homework). Deliberately excludes `ta` -- see GRADER_ROLES below.
 *
 *  Exported so the AuthContext test double (server/testing/authContext.ts)
 *  builds its predicates from the same list production uses, rather than
 *  restating it -- otherwise a role moved between tiers leaves every route
 *  test asserting the old rule while only roles.test.ts catches it. */
export const AUTHOR_ROLES: readonly CourseRole[] = ["instructor", "admin"];

/** Roles that may read student work for grading (the submissions dashboard
 *  and an individual student's section answer). #172: a TA is a grader, not
 *  an author -- before this split, `ta` was granted admin-console access by
 *  apps/admin while every instructor-gated API rejected it, so a TA loaded a
 *  console where nothing worked. */
export const GRADER_ROLES: readonly CourseRole[] = ["instructor", "admin", "ta"];

export interface AuthContext {
  session: SessionPayload;
  memberships: Membership[];
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

  const db = makeDb(c.env.DATABASE_URL);
  const [memberships, activation] = await Promise.all([
    listMembershipsForUser(db, session.userId),
    getUserActivationState(db, session.userId),
  ]);

  // Deprovisioned (isActive=false), or this cookie predates the account's
  // current session_epoch (a WorkOS deprovisioning webhook bumped it since
  // this cookie was issued) -- either way the cookie is cryptographically
  // valid but no longer authorized. Same 401 shape as authMiddleware's "no
  // session" case; the caller can't tell a revoked session from no session
  // at all, which is the point.
  if (!activation || !activation.isActive || activation.sessionEpoch !== session.sessionEpoch) {
    return c.json({ error: "Unauthorized" }, 401);
  }

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

  /** Instructors/admins always hold the capability; a TA holds it only where
   *  the per-membership flag was granted; every other role never does. */
  const capability = (courseId: string, flag: "canViewSolutions" | "canViewDrafts") => {
    const membership = membershipIn(courseId);
    if (!membership) return false;
    if (AUTHOR_ROLES.includes(membership.role)) return true;
    return membership.role === "ta" && membership[flag];
  };

  const roleIn = (courseId: string, allowed: readonly CourseRole[]) => {
    const membership = membershipIn(courseId);
    return membership !== undefined && allowed.includes(membership.role);
  };

  const authContext: AuthContext = {
    session,
    memberships,
    // Not course-scoped: "do I hold this role anywhere" is a genuine
    // any-membership question, so `.some()` is correct here.
    hasRole: (role) => memberships.some((m) => m.role === role),
    isMemberOf: (courseId) => membershipIn(courseId) !== undefined,
    isInstructorOf: (courseId) => roleIn(courseId, AUTHOR_ROLES),
    isGraderOf: (courseId) => roleIn(courseId, GRADER_ROLES),
    canViewSolutionsIn: (courseId) => capability(courseId, "canViewSolutions"),
    canViewDraftsIn: (courseId) => capability(courseId, "canViewDrafts"),
  };

  c.set("authContext", authContext);
  await next();
}
