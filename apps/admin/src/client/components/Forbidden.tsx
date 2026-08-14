/* --------------------------------------------------------------------------
   Forbidden — branded 403 shown to an authenticated user who isn't an
   instructor/TA/admin for any course. Distinct from UnauthenticatedAdmin
   (no session at all) -- this is "you're signed in, but this console isn't
   for you" (issue #10: "students hitting it get a branded 403").

   Previously this centred an <AdminNotice> in the viewport. AdminNotice is a
   good component and stays exactly as it is -- but it's an IN-FLOW block, a
   filed record sitting in the 1080px records column, which is what its seven
   other call sites use it as. Centring an in-flow block in an empty viewport
   is what produced a card floating in a void: the container reads as
   arbitrary, because at page scale there's nothing for it to be contained
   relative to.

   So the denial is composed at page scale instead. Same console vernacular --
   editorial ledger, mono status line, Heritage Gold as the permission colour
   (never red: a 403 is a fact about your roles, not a failure) -- but the
   leading rule is promoted from a card border to page architecture, running
   the full height of the content with the refusal set along it like the
   spine label on a filed folder. That's a device a card can't do, which is
   the point.

   The prose paragraph is now a two-row ledger. It carries the same facts, but
   "which roles open this console" and "which ones you hold" are the reader's
   actual questions, and a ledger answers them at a glance where a sentence
   makes them parse for it.
   -------------------------------------------------------------------------- */

import { TopNav } from "@llteacher/ui";

export interface ForbiddenProps {
  /** Two-letter initials for the nav avatar. */
  userInitials?: string;
  /** When provided, offers "Sign out" so the state isn't a dead end. */
  onLogout?: () => void;
}

/** The roles that open the console, in descending scope. Mirrors the tiers in
 *  packages/ui/src/auth/courseRole.ts -- if that grows a tier, this list is
 *  the user-facing half of the same fact and needs to grow with it. */
const ACCESS_ROLES = ["Course admin", "Instructional lead", "Teaching assistant"];

export function Forbidden({ userInitials = "—", onLogout }: ForbiddenProps) {
  return (
    <div className="page-frame">
      <TopNav
        course="STATS 311"
        term="Autumn 2026"
        homework="ACCESS"
        userInitials={userInitials}
        admin
        isAuthenticated
        onLogout={onLogout}
      />

      <main className="access-gate">
        {/* Rail — the full-height rule, with the file-spine label set along
            it. aria-hidden because it restates the eyebrow below verbatim;
            it's a visual device, not a second announcement. */}
        <div className="access-gate__rail" aria-hidden="true">
          <span className="access-gate__spine">Access denied · STATS 311 · Autumn 2026</span>
        </div>

        <div className="access-gate__body">
          <p className="access-gate__eyebrow">
            <span className="access-gate__dot" aria-hidden="true" />
            403 · Access denied
          </p>

          <h1 className="access-gate__title">This console is for teaching staff</h1>

          <dl className="access-gate__ledger">
            <div className="access-gate__row">
              <dt>Access requires</dt>
              <dd>
                <ul className="access-gate__roles">
                  {ACCESS_ROLES.map((role) => (
                    <li key={role}>{role}</li>
                  ))}
                </ul>
              </dd>
            </div>
            <div className="access-gate__row">
              <dt>Your account</dt>
              <dd>No teaching role in any course</dd>
            </div>
          </dl>

          <p className="access-gate__next">
            Ask a course instructor to grant you a role. It takes effect the next time you sign in.
          </p>

          {onLogout && (
            <button type="button" className="access-gate__action" onClick={onLogout}>
              Sign out
            </button>
          )}
        </div>
      </main>
    </div>
  );
}
