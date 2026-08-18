/* --------------------------------------------------------------------------
   ViewState — the loading and failure states every console view shares (#33).

   Pairs with useApiResource. The reason it is a component rather than a
   convention: the two decisions it makes are the ones views got wrong
   individually.

     · A permission outcome is not a failure. 403 and 404 take AdminNotice's
       "denied" tone and offer no Try again, because retrying cannot change
       them -- #191's finding, applied everywhere rather than in one view.
     · The loading state carries no live-region role. A block inserted into
       the DOM already containing its text does not reliably announce
       (#204/ACC-028); views announce through their own permanent region.
   -------------------------------------------------------------------------- */

import { AdminNotice } from "./AdminNotice";
import type { ApiError } from "../lib/api-client";

export function ViewLoading({ label }: { label: string }) {
  return <p className="admin-loading">{label}</p>;
}

export function ViewError({
  error,
  onRetry,
  detail,
}: {
  error: ApiError;
  onRetry: () => void;
  /** The endpoint, for an admin filing a bug. */
  detail?: string;
}) {
  const denied = error.kind === "denied" || error.kind === "missing";
  return (
    <AdminNotice
      eyebrow={denied ? "Not available" : "Could not load"}
      title={denied ? "This is not available to you" : "That didn't load"}
      body={error.message}
      tone={denied ? "denied" : "error"}
      // Only when retrying could plausibly work. ApiError already knows.
      onRetry={error.retryable ? onRetry : undefined}
      detail={detail}
    />
  );
}

/** The empty state. Distinct from a failure on purpose: "there is nothing
 *  here yet" and "we could not find out" are different sentences, and
 *  collapsing them is how a console tells an instructor their course is
 *  empty when the server is simply down. */
export function ViewEmpty({
  icon,
  title,
  body,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  body?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="admin-empty">
      {icon ? (
        <span aria-hidden="true" className="admin-empty__icon">
          {icon}
        </span>
      ) : null}
      <p className="admin-empty__title">{title}</p>
      {body ? <p className="admin-empty__body">{body}</p> : null}
      {action ? <div className="admin-empty__action">{action}</div> : null}
    </div>
  );
}
