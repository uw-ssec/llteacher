import { createAuthProvider, parseCourseRole, type AuthSessionState, type CourseRole } from "@llteacher/ui";

export type { CourseRole };
export interface CourseOption { id: string; title: string }
export type AuthState = AuthSessionState & { role: CourseRole | null; courses: CourseOption[] };

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
    const courses: CourseOption[] = Array.isArray(raw?.courses) ? (raw.courses as CourseOption[]) : [];
    return { role, courses };
  },
  defaultExtra: { role: null, courses: [] },
});
