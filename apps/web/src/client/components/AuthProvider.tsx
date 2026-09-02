import { createAuthProvider, type AuthSessionState } from "@llteacher/ui";

/** #434 review: the context value is `AuthSessionState & WebAuthExtra`, so
 *  this alias was quietly dropping `displayName` from anything that used it.
 *  Nothing imports it today, which is why it went unnoticed -- but an
 *  exported type that does not describe what `useAuth()` returns is a trap
 *  for the first caller that does. Matches apps/admin's counterpart, which
 *  declares the intersection. */
export type AuthState = AuthSessionState & WebAuthExtra;

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
 *  inventing letters (#294).
 *
 *  #434 review: takes the FIRST TWO whitespace-separated parts, matching
 *  apps/admin's two existing call sites exactly -- "Ada Byron Lovelace"
 *  gives "AB". This originally took first+last ("AL"), which is arguably the
 *  better reading of a person's initials but meant the same student saw
 *  different letters in the student nav and the admin console. Agreeing with
 *  the app that already shipped is worth more than being right alone.
 *
 *  It is still a third copy of this logic. Unifying all three in
 *  @llteacher/ui, next to createAuthProvider, and settling which convention
 *  is actually wanted is tracked separately -- doing it here would mean a
 *  behaviour change in apps/admin inside a PR about the student nav. */
export function initialsFrom(displayName: string | null): string | null {
  if (!displayName) return null;
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  return parts
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}
