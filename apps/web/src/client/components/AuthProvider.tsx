import { createAuthProvider, type AuthSessionState } from "@llteacher/ui";

/** #294: the two identity fields App.tsx needs to derive real user
 *  initials for TopNav instead of the hardcoded "AC" stand-in --
 *  GET /api/profile always returns `email`, but `displayName` is
 *  nullable (ProfileWithStats, apps/web/src/shared/types.ts) for a user
 *  who never set one. */
export interface AuthExtra {
  email?: string;
  displayName?: string | null;
}

export type AuthState = AuthSessionState & AuthExtra;

export const { AuthProvider, useAuth } = createAuthProvider<AuthExtra>({
  defaultExtra: { email: undefined, displayName: null },
  parseExtra: (body) => {
    const b = body as { email?: unknown; displayName?: unknown };
    return {
      email: typeof b.email === "string" ? b.email : undefined,
      displayName: typeof b.displayName === "string" ? b.displayName : null,
    };
  },
});
