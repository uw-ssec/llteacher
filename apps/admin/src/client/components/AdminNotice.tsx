/* --------------------------------------------------------------------------
   AdminNotice — the console's shared failure/denial block.

   Every "this did not work" moment in the admin app used to render as a bare
   <p role="alert">Failed to load X.</p>: unstyled body text sitting flush in
   the 1080px records column, with no container, no cause, and no way forward.
   This is the one block they all route through.

   Two tones:
     "error"  — a request failed (red rule). Recoverable; offer a retry.
     "denied" — an authorization fact (Heritage Gold rule). Not a fault, and
                deliberately not dressed in the same red as a broken fetch.

   The visual language (mono status eyebrow with a state dot, leading rule,
   pilcrow watermark, corner hatch) lives in packages/ui/styles.css under
   .admin-notice.
   -------------------------------------------------------------------------- */

import { ArrowClockwise } from "@phosphor-icons/react";

export type AdminNoticeTone = "error" | "denied";

export interface AdminNoticeProps {
  /** Mono status line, e.g. "COULD NOT LOAD" or "403 · ACCESS DENIED". */
  eyebrow: string;
  /** The headline — what happened, in plain language. */
  title: string;
  /** One or two sentences: what it means and what the reader can do. */
  body?: React.ReactNode;
  /** Technical line (endpoint, id) for an admin filing a bug. Mono, quiet. */
  detail?: string;
  /** Red (a request failed) vs gold (a permission fact). Defaults to error. */
  tone?: AdminNoticeTone;
  /** Renders the primary "Try again" action. Omit when nothing can be retried. */
  onRetry?: () => void;
  /** Optional secondary action, e.g. "Back" or "Sign out". */
  secondaryAction?: { label: string; onClick: () => void };
}

export function AdminNotice({
  eyebrow,
  title,
  body,
  detail,
  tone = "error",
  onRetry,
  secondaryAction,
}: AdminNoticeProps) {
  return (
    <div
      className={tone === "denied" ? "admin-notice admin-notice--denied" : "admin-notice"}
      /* role="alert" only for failures. A 403 is the page's whole content, not
         an interruption, and announcing it assertively fights the heading. */
      role={tone === "error" ? "alert" : undefined}
    >
      <span className="admin-notice__mark" aria-hidden="true">
        ¶
      </span>

      <span className="admin-notice__eyebrow">
        <span className="admin-notice__dot" aria-hidden="true" />
        {eyebrow}
      </span>

      <h2 className="admin-notice__title">{title}</h2>

      {body && <p className="admin-notice__body">{body}</p>}

      {detail && <p className="admin-notice__detail">{detail}</p>}

      {(onRetry || secondaryAction) && (
        <div className="admin-notice__actions">
          {onRetry && (
            <button type="button" className="admin-notice__action" onClick={onRetry}>
              <span className="admin-notice__action-glyph" aria-hidden="true">
                <ArrowClockwise size={14} weight="bold" />
              </span>
              Try again
            </button>
          )}
          {secondaryAction && (
            <button
              type="button"
              className="admin-notice__action admin-notice__action--ghost"
              onClick={secondaryAction.onClick}
            >
              {secondaryAction.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
