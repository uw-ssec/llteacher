/* --------------------------------------------------------------------------
   DegradedRoleBanner — says so when the console has narrowed the caller's
   access because it could not confirm their role (#193, #172 re-audit
   USE-024).

   The condition: /api/profile returned a course entry with no `role`, which
   is exactly what an older Worker serves during this feature's own rolling
   deploy. parseCourse degrades that entry to the NARROWEST console role, so
   `canAuthor` computes false for a real instructor -- the New homework
   button disappears, the TA permissions nav entry disappears, and clicking a
   homework opens the read-only view.

   Deny-by-default is right and does not change here. Shipping it mute is the
   defect: the only signal was a console.warn, and that fires for *dropped*
   entries rather than degraded ones. An instructor reloading mid-deploy saw
   their authoring controls vanish with nothing to distinguish a revoked
   permission from a pulled feature from a broken app, and filed a
   permissions-escalation ticket for a condition that clears itself in
   minutes.

   Dismissible, because the degrade persists for the length of the deploy and
   a banner that cannot be closed becomes furniture. Dismissal is per mount:
   a reload is the recovery action being recommended, so it must bring the
   banner back if the condition is still true.
   -------------------------------------------------------------------------- */

import { useState } from "react";
import { Warning, X } from "@phosphor-icons/react";

export function DegradedRoleBanner({ courseTitle }: { courseTitle?: string }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  return (
    <div className="admin-banner admin-banner--degraded" role="status">
      <span className="admin-banner__icon" aria-hidden="true">
        <Warning size={16} weight="regular" />
      </span>
      <p className="admin-banner__body">
        Some permissions could not be confirmed
        {courseTitle ? ` for ${courseTitle}` : ""}, so the console is showing you read-only
        access. This usually clears after a moment — reload to retry. If it persists, contact
        your program administrator.
      </p>
      <button
        type="button"
        className="admin-banner__dismiss"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss permissions notice"
      >
        <X size={14} weight="bold" aria-hidden="true" />
      </button>
    </div>
  );
}
