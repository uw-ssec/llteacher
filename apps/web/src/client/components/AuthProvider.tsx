import { createAuthProvider, type AuthSessionState } from "@llteacher/ui";

export type AuthState = AuthSessionState;

export const { AuthProvider, useAuth } = createAuthProvider({ defaultExtra: {} });
