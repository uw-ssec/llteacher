import { createAuthProvider, type AuthSessionState } from "@llteacher/ui";

export type AuthState = AuthSessionState;

/** #294: the signed-in student's own display name, read off GET /api/profile.
 *  The nav used to render a hardcoded `userInitials="AC"` -- initials
 *  belonging to no signed-in user, shown to every student. The data was
 *  already fetched by this provider; only the parse was missing. */
export interface WebAuthExtra {
  displayName: string | null;
}

function parseDisplayName(body: unknown): WebAuthExtra {
  const displayName = (body as { displayName?: unknown } | null)?.displayName;
  return { displayName: typeof displayName === "string" && displayName.trim() !== "" ? displayName : null };
}

export const { AuthProvider, useAuth } = createAuthProvider<WebAuthExtra>({
  parseExtra: parseDisplayName,
  defaultExtra: { displayName: null },
});

/** Two-letter initials for the avatar chip, or null when there is no name to
 *  derive them from -- the chip renders a neutral placeholder rather than
 *  inventing letters (#294). Takes the first letter of the first and last
 *  whitespace-separated parts, so "Ada Byron Lovelace" gives "AL". */
export function initialsFrom(displayName: string | null): string | null {
  if (!displayName) return null;
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  const first = parts[0]![0]!;
  const last = parts.length > 1 ? parts[parts.length - 1]![0]! : "";
  return (first + last).toUpperCase();
}
