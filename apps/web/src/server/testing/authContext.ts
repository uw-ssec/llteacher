import type { AuthContext, CourseRole } from "../middleware/roles";

type Membership = AuthContext["memberships"][number];

/** Builds a membership row for AuthContext fixtures. Preferred over
 *  stubbing a predicate directly (`isInstructorOf: () => true`): the
 *  predicates below derive from memberships exactly as production does, so
 *  a test built on real data can't assert behaviour the real rule wouldn't
 *  produce. Capability flags default false, matching the column defaults. */
export function fakeMembership(overrides: Partial<Membership> & { courseId: string; role: CourseRole }): Membership {
  return {
    id: `membership-${overrides.courseId}-${overrides.role}`,
    userId: "u1",
    canViewSolutions: false,
    canViewDrafts: false,
    droppedAt: null,
    ...overrides,
  } as unknown as Membership;
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
  const membershipIn = (courseId: string) => memberships.find((m) => m.courseId === courseId);
  const authors = (courseId: string) => {
    const m = membershipIn(courseId);
    return m?.role === "instructor" || m?.role === "admin";
  };
  return {
    session: { userId: "u1", workosUserId: "w1", sessionEpoch: 0, issuedAt: 0, expiresAt: 0 },
    memberships,
    hasRole: (role) => memberships.some((m) => m.role === role),
    isMemberOf: (courseId) => memberships.some((m) => m.courseId === courseId),
    isInstructorOf: (courseId) => authors(courseId),
    isGraderOf: (courseId) => {
      const m = membershipIn(courseId);
      return m?.role === "instructor" || m?.role === "admin" || m?.role === "ta";
    },
    canViewSolutionsIn: (courseId) => {
      const m = membershipIn(courseId);
      if (!m) return false;
      return authors(courseId) || (m.role === "ta" && m.canViewSolutions);
    },
    canViewDraftsIn: (courseId) => {
      const m = membershipIn(courseId);
      if (!m) return false;
      return authors(courseId) || (m.role === "ta" && m.canViewDrafts);
    },
    ...overrides,
  };
}
