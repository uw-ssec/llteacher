import { AUTHOR_ROLES, GRADER_ROLES, type AuthContext, type CourseRole } from "../middleware/roles";
import { resolveTaCapabilities, type TaCapabilityField } from "@llteacher/ui/auth/courseRole";

type Membership = AuthContext["memberships"][number];

/** Builds a membership row for AuthContext fixtures. Preferred over
 *  stubbing a predicate directly (`isInstructorOf: () => true`): the
 *  predicates below derive from memberships exactly as production does, so
 *  a test built on real data can't assert behaviour the real rule wouldn't
 *  produce. Capability flags default false, matching the column defaults.
 *
 *  #172 re-audit (MNT-006): no `as unknown as Membership` and no `droppedAt`.
 *  AuthContext's Membership is the six-column projection
 *  listMembershipsForUser returns, which does not include droppedAt -- that
 *  filter is applied in SQL, so a row reaching AuthContext is active by
 *  construction. The stale field was what forced the double cast, and the
 *  double cast was in turn suppressing any error if the projection and this
 *  double ever diverged again. Typed straight through, they cannot. */
export function fakeMembership(
  overrides: Partial<Membership> & { courseId: string; role: CourseRole },
): Membership {
  return {
    id: `membership-${overrides.courseId}-${overrides.role}`,
    userId: "u1",
    canViewSolutions: false,
    canViewDrafts: false,
    ...overrides,
  };
}

/** Shared AuthContext test double.
 *
 *  Extracted in #172: six test files had each grown their own copy, and they
 *  had drifted -- some derived the predicates from `memberships`, others
 *  hardcoded `false` -- so adding one member to AuthContext broke all six at
 *  once. One definition means the next predicate is a one-line change here.
 *
 *  Predicates are derived from `memberships` exactly as rolesMiddleware
 *  derives them in production, so a suite that sets up a realistic
 *  membership gets realistic behaviour rather than a hand-stubbed answer
 *  that can disagree with the real rule. Any predicate can still be
 *  overridden outright when a test wants to isolate one branch.
 *
 *  With no memberships every predicate is false, which is the safe default:
 *  a test must opt into permission rather than inherit it.
 *
 *  Not named `*.test.ts` on purpose -- vitest's `include` is
 *  `src/**\/*.test.ts`, so this is importable without being collected as an
 *  empty suite. */
export function fakeAuthContext(overrides: Partial<AuthContext> = {}): AuthContext {
  const memberships = overrides.memberships ?? [];

  // Mirrors rolesMiddleware's structure exactly: resolve the course's
  // membership once, then ask questions about that single row, using the
  // same exported role lists production uses. Restating either the lookup
  // shape or the role sets here would let the suite assert a rule
  // production does not implement.
  const membershipIn = (courseId: string) => memberships.find((m) => m.courseId === courseId);
  const roleIn = (courseId: string, allowed: readonly CourseRole[]) => {
    const m = membershipIn(courseId);
    return m !== undefined && allowed.includes(m.role);
  };
  const capability = (courseId: string, flag: TaCapabilityField) => {
    const m = membershipIn(courseId);
    return m ? resolveTaCapabilities(m)[flag] : false;
  };

  return {
    session: { userId: "u1", workosUserId: "w1", sessionEpoch: 0, issuedAt: 0, expiresAt: 0 },
    memberships,
    hasRole: (role) => memberships.some((m) => m.role === role),
    isMemberOf: (courseId) => membershipIn(courseId) !== undefined,
    isInstructorOf: (courseId) => roleIn(courseId, AUTHOR_ROLES),
    isGraderOf: (courseId) => roleIn(courseId, GRADER_ROLES),
    canViewSolutionsIn: (courseId) => capability(courseId, "canViewSolutions"),
    canViewDraftsIn: (courseId) => capability(courseId, "canViewDrafts"),
    ...overrides,
  };
}
