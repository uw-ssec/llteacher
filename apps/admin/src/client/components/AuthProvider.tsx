import { createAuthProvider, parseCourseRole, type AuthSessionState, type CourseRole } from "@llteacher/ui";

export type { CourseRole };

/** The least-privileged role that still admits someone to the console.
 *  Used only as a degrade target, so a skewed payload never widens access. */
const NARROWEST_CONSOLE_ROLE: CourseRole = "ta";

/** #172: carries the caller's role and resolved capabilities *for this
 *  course*. The top-level `role` below is a priority-ranked primary role
 *  across every membership, which is the wrong thing to gate a course-scoped
 *  UI on -- an instructor in course A who is a TA in course B has primary
 *  role "instructor" and would otherwise be shown authoring controls for B
 *  that the server refuses. Prefer the per-course values everywhere. */
export interface CourseOption {
  id: string;
  title: string;
  role: CourseRole;
  canViewSolutions: boolean;
  canViewDrafts: boolean;
  /** #193: true when this entry arrived with no `role` and was degraded to
   *  NARROWEST_CONSOLE_ROLE rather than carrying a role the server stated.
   *
   *  The degrade itself is the SEC-005 fix and is correct. What was missing
   *  was any way to say so: the only signal was a console.warn, and that
   *  fires for *dropped* entries, not degraded ones. So a real instructor
   *  reloading mid-deploy watched their authoring controls disappear with
   *  nothing on screen distinguishing "your permissions were revoked" from
   *  "the feature was pulled" from "the app is broken" -- for a condition
   *  that resolves itself the moment the Worker catches up. */
  roleDegraded: boolean;
}

export type AuthState = AuthSessionState & {
  role: CourseRole | null;
  courses: CourseOption[];
  /** #33: the signed-in instructor's own name, for the chrome. The console
   *  used to take this from a fixture teacher, which meant every instructor
   *  saw the same initials in the top nav of a tool whose whole purpose is
   *  acting on their behalf. */
  displayName: string | null;
};

/** Runtime-validated rather than cast (#124).
 *
 *  `id` and `title` are structural -- an entry without them is unusable and
 *  gets dropped. The #172 fields degrade instead of dropping, because
 *  apps/admin and apps/web deploy independently: during a rolling deploy an
 *  older server still returns the pre-#172 `{ id, title }` shape, and
 *  dropping those entries would leave the console claiming the instructor
 *  has no courses at all.
 *
 *  Degradation is genuinely deny-by-default: a missing `role` falls back to
 *  the NARROWEST console role (not the caller's widest), an unrecognized
 *  role drops the entry outright, and absent capability flags read as false
 *  rather than granting anything the payload never claimed. */
function parseCourse(raw: unknown, fallbackRole: CourseRole | null): CourseOption | null {
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.id !== "string" || typeof c.title !== "string") return null;

  // #172 audit (SEC-005/REL-007/CMP-003): two distinct cases, previously
  // collapsed into one permissive fallback.
  //
  // `role` ABSENT means a pre-#172 server -- degrade, but to the narrowest
  // console role rather than the caller's priority-ranked primary role. The
  // primary role is the WIDEST role they hold anywhere, so an instructor in
  // course A who assists course B was shown authoring controls for B that
  // every write 403s: the exact defect #172 fixes, resurrected for the
  // length of a rolling deploy.
  //
  // `role` PRESENT but unrecognized means a NEWER server added a course role
  // this bundle doesn't know. Inheriting the primary role there is strictly
  // worse -- it widens on a value that was explicitly narrower. Drop the
  // entry so the warning below fires and nothing is granted on a guess.
  if (c.role !== undefined && parseCourseRole(c.role) === null) return null;
  const statedRole = typeof c.role === "string" ? parseCourseRole(c.role) : null;
  const role = statedRole ?? (fallbackRole ? NARROWEST_CONSOLE_ROLE : null);
  if (!role) return null;
  return {
    id: c.id,
    title: c.title,
    role,
    canViewSolutions: c.canViewSolutions === true,
    canViewDrafts: c.canViewDrafts === true,
    // #193: the degrade is recorded, not just performed. Nothing about the
    // access decision changes -- this only lets the console explain itself.
    roleDegraded: statedRole === null,
  };
}

export const { AuthProvider, useAuth } = createAuthProvider<{
  role: CourseRole | null;
  courses: CourseOption[];
  displayName: string | null;
}>({
  parseExtra: (body) => {
    const raw = body as { role?: unknown; courses?: unknown; displayName?: unknown } | null;
    let role: CourseRole | null = null;
    if (raw?.role != null) {
      const parsed = parseCourseRole(raw.role);
      if (!parsed) {
        console.warn(`[AuthProvider] /api/profile returned an unrecognized role: ${String(raw.role)}`);
      }
      role = parsed;
    }
    const rawCourses = Array.isArray(raw?.courses) ? raw.courses : [];
    const courses = rawCourses
      .map((c) => parseCourse(c, role))
      .filter((c): c is CourseOption => c !== null);
    if (courses.length !== rawCourses.length) {
      console.warn(
        `[AuthProvider] /api/profile returned ${rawCourses.length - courses.length} malformed course entr(ies); dropped`,
      );
    }
    return {
      role,
      courses,
      // Null rather than a placeholder when absent: the chrome falls back to
      // a neutral glyph, because showing the WRONG person's initials in an
      // admin console is worse than showing none.
      displayName: typeof raw?.displayName === "string" ? raw.displayName : null,
    };
  },
  defaultExtra: { role: null, courses: [], displayName: null },
});
