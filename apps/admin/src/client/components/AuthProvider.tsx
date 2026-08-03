import { createAuthProvider, parseCourseRole, type AuthSessionState, type CourseRole } from "@llteacher/ui";

export type { CourseRole };
export type AuthState = AuthSessionState & { role: CourseRole | null };

export const { AuthProvider, useAuth } = createAuthProvider<{ role: CourseRole | null }>({
  parseExtra: (body) => {
    const raw = (body as { role?: unknown } | null)?.role;
    if (raw == null) return { role: null };
    const role = parseCourseRole(raw);
    if (!role) {
      // eslint-disable-next-line no-console
      console.warn(`[AuthProvider] /api/profile returned an unrecognized role: ${String(raw)}`);
    }
    return { role };
  },
  defaultExtra: { role: null },
});
