import { createAuthProvider, parseCourseRole, type AuthSessionState, type CourseRole } from "@llteacher/ui";

export type { CourseRole };

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
}

export type AuthState = AuthSessionState & { role: CourseRole | null; courses: CourseOption[] };

/** Runtime-validated rather than cast (#124).
 *
 *  `id` and `title` are structural -- an entry without them is unusable and
 *  gets dropped. The #172 fields degrade instead of dropping, because
 *  apps/admin and apps/web deploy independently: during a rolling deploy an
 *  older server still returns the pre-#172 `{ id, title }` shape, and
 *  dropping those entries would leave the console claiming the instructor
 *  has no courses at all.
 *
 *  Degradation is deny-by-default: a missing `role` falls back to the
 *  caller's top-level primary role, restoring exactly the pre-#172
 *  behaviour, and absent capability flags read as false rather than
 *  granting anything the payload never claimed. */
function parseCourse(raw: unknown, fallbackRole: CourseRole | null): CourseOption | null {
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.id !== "string" || typeof c.title !== "string") return null;
  const role = (typeof c.role === "string" ? parseCourseRole(c.role) : null) ?? fallbackRole;
  if (!role) return null;
  return {
    id: c.id,
    title: c.title,
    role,
    canViewSolutions: c.canViewSolutions === true,
    canViewDrafts: c.canViewDrafts === true,
  };
}

export const { AuthProvider, useAuth } = createAuthProvider<{ role: CourseRole | null; courses: CourseOption[] }>({
  parseExtra: (body) => {
    const raw = body as { role?: unknown; courses?: unknown } | null;
    let role: CourseRole | null = null;
    if (raw?.role != null) {
      const parsed = parseCourseRole(raw.role);
      if (!parsed) {
        // eslint-disable-next-line no-console
        console.warn(`[AuthProvider] /api/profile returned an unrecognized role: ${String(raw.role)}`);
      }
      role = parsed;
    }
    const rawCourses = Array.isArray(raw?.courses) ? raw.courses : [];
    const courses = rawCourses
      .map((c) => parseCourse(c, role))
      .filter((c): c is CourseOption => c !== null);
    if (courses.length !== rawCourses.length) {
      // eslint-disable-next-line no-console
      console.warn(
        `[AuthProvider] /api/profile returned ${rawCourses.length - courses.length} malformed course entr(ies); dropped`,
      );
    }
    return { role, courses };
  },
  defaultExtra: { role: null, courses: [] },
});
