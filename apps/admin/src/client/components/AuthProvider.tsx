import { createAuthProvider, type AuthSessionState } from "@llteacher/ui";

/** Mirrors apps/web's role union without importing across the app boundary
 *  (admin has no access to apps/web's server-side types). Kept as a plain
 *  string union here; both sides ultimately derive from the same
 *  course_role Postgres enum (apps/web/src/db/schema/identity.ts). */
export type CourseRole = "instructor" | "ta" | "student" | "observer" | "admin";

export type AuthState = AuthSessionState & { role: CourseRole | null };

export const { AuthProvider, useAuth } = createAuthProvider<{ role: CourseRole | null }>({
  parseExtra: (body) => ({ role: (body as { role?: CourseRole | null } | null)?.role ?? null }),
  defaultExtra: { role: null },
});
