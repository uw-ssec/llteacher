import { createAuthProvider, type AuthSessionState } from "@llteacher/ui";
import type { CourseMembershipSummary } from "../../shared/types";

/** #294: the two identity fields App.tsx needs to derive real user initials
 *  for TopNav -- GET /api/profile always returns `email`, but `displayName`
 *  is nullable for a user who never set one. The staff fields let the app
 *  land course staff who hold no student membership on the teaching
 *  workspace without a second request. */
export interface AuthExtra {
  email?: string;
  displayName?: string | null;
  staffOnly: boolean;
  /** Courses where the caller holds a staff role, from the same profile body. */
  staffCourses: CourseMembershipSummary[];
}

export type AuthState = AuthSessionState & AuthExtra;

const STAFF_ROLES = ["instructor", "ta", "admin"];

export const { AuthProvider, useAuth } = createAuthProvider<AuthExtra>({
  defaultExtra: { email: undefined, displayName: null, staffOnly: false, staffCourses: [] },
  parseExtra: (body) => {
    const b = body as { email?: unknown; displayName?: unknown; role?: string; studentStats?: unknown; courses?: unknown };
    const staffOnly = STAFF_ROLES.includes(b.role ?? "") && !b.studentStats;
    const staffCourses = Array.isArray(b.courses)
      ? (b.courses as CourseMembershipSummary[]).filter((c) => STAFF_ROLES.includes(c.role))
      : [];
    return {
      email: typeof b.email === "string" ? b.email : undefined,
      displayName: typeof b.displayName === "string" ? b.displayName : null,
      staffOnly,
      staffCourses,
    };
  },
});

/** Two-letter initials for the account pages' avatar, or null when there is
 *  no name to derive them from. First two whitespace-separated parts, the
 *  same convention apps/admin uses. */
export function initialsFrom(displayName: string | null | undefined): string | null {
  if (!displayName) return null;
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  return parts.map((p) => p[0]).join("").slice(0, 2).toUpperCase();
}
