import { useEffect, useId, useRef } from "react";
import { Button } from "./Button";

/* --------------------------------------------------------------------------
   AlertDialog — labelled, focus-trapped, Escape-dismissible confirm dialog
   for destructive actions (#248).

   Built on the native <dialog> element rather than a hand-rolled focus
   trap: dialog.showModal() gives real focus containment (Tab cannot escape
   the dialog) and native Escape handling (fires `cancel`, which this
   component turns into onCancel) for free, in every evergreen browser this
   app targets. role="alertdialog" is added explicitly per the ARIA APG
   pattern for confirm dialogs -- the element's implicit role alone isn't
   consistently "alertdialog" across browsers.

   This is the first destructive-action confirm surface in the student app
   (#248's own audit found only two bare `window.confirm` calls, both in
   apps/admin, neither stylable/labelled/focus-managed) -- it exists so the
   next one has a real primitive to reach for instead of a third
   window.confirm.

   Controlled component: the parent owns `open` and both callbacks. This
   component only owns the native <dialog> show/close lifecycle and the
   Escape/backdrop-click -> onCancel wiring. -------------------------------------------------------------------------- */

export interface AlertDialogProps {
  open: boolean;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** Danger for destructive actions (default); accent for merely
   *  consequential ones. */
  confirmVariant?: "danger" | "accent";
  /** Disables both actions and shows a busy state on confirm -- for a
   *  confirm that kicks off an in-flight request the caller wants the
   *  dialog to stay open through (e.g. surfacing a server-side refusal
   *  inline via `description` on failure, rather than closing blind). */
  confirming?: boolean;
}

export function AlertDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
  confirmVariant = "danger",
  confirming = false,
}: AlertDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  /* Self-healing on every render, not just when `open` changes (PR #317
     review finding): the native <dialog> can close itself independently of
     React's `open` prop (the `cancel` event below, or any future path that
     calls the browser's own close), and a `[open]`-keyed effect only
     re-checks when `open` itself changes value -- if `open` stays `true`
     across that desync (exactly what happened here: `cancelRestart`
     early-returns while `confirming`, so `restartDialogOpen` never flips),
     the mismatch stands forever. Both branches are idempotent -- showModal()
     no-ops if already open, close() no-ops if already closed -- so running
     this after every render is safe, not just after `open` transitions. */
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  });

  // Escape fires `cancel` (then `close`) on a native <dialog>. Normally we
  // let the browser's default close proceed and tell the parent so its
  // `open` state stays in sync -- but while `confirming` (a request is
  // in flight and the dialog must stay open to show a server-side refusal
  // inline, see the `confirming` prop doc comment), the native `cancel`
  // event is cancelable and closing the DOM dialog out from under React's
  // `open === true` is exactly the desync the effect above now heals, but
  // preventing it here means the healing effect never has to fire for this
  // specific, most-common cause of it (#317 review: Escape during restart
  // permanently bricked the Restart button before this fix).
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handleCancel = (e: Event) => {
      if (confirming) {
        e.preventDefault();
        return;
      }
      onCancel();
    };
    dialog.addEventListener("cancel", handleCancel);
    return () => dialog.removeEventListener("cancel", handleCancel);
  }, [onCancel, confirming]);

  return (
    <dialog
      ref={dialogRef}
      className="alert-dialog"
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onClick={(e) => {
        // A click that lands on the <dialog> element itself (not any child)
        // is a backdrop click -- treat it as cancel, matching the Escape
        // affordance rather than silently doing nothing.
        if (e.target === dialogRef.current) onCancel();
      }}
    >
      <h2 id={titleId} className="alert-dialog__title">
        {title}
      </h2>
      <div id={descriptionId} className="alert-dialog__description">
        {description}
      </div>
      {/* #317 review, #327: `ariaDisabled`/`loading` (both aria-disabled
          under the hood, see Button.tsx), not `disabled` -- the previous
          version's `disabled={confirming}` on Cancel plus `loading`'s own
          old native-disable behavior on Confirm meant a confirming dialog
          had ZERO focusable descendants: nothing to receive focus, and
          "Confirming…" announced nowhere (a native `disabled` button is
          dropped from the accessibility tree in several AT). Both actions
          now stay focusable and merely refuse activation while confirming. */}
      <div className="alert-dialog__actions">
        <Button variant="default" outlined onClick={onCancel} ariaDisabled={confirming}>
          {cancelLabel}
        </Button>
        <Button variant={confirmVariant} onClick={onConfirm} loading={confirming}>
          {confirmLabel}
        </Button>
      </div>
      {/* #327: role="status" progress line -- announced the moment
          `confirming` flips true, independent of whichever action happens
          to have focus. Visually hidden via the .sr-only utility class
          (styles.css) so it doesn't shift the dialog's layout.

          #317 review, #345: mounted unconditionally, with the text as the
          only thing that changes -- a live region has to already be
          registered in the accessibility tree BEFORE its content changes to
          be observed as a change at all (ARIA22). The previous version
          mounted this `<p>` conditionally, with its text already inside it
          on arrival, which several AT never announce -- the student presses
          Confirm and hears nothing for the whole request; if it then fails,
          the role="alert" description is the first feedback of any kind.
          ConversationView.tsx's turn-complete announcement 300+ lines away
          already gets this right (mounted always, gated only on text). */}
      <p className="sr-only" role="status">
        {confirming ? `${confirmLabel} in progress…` : ""}
      </p>
    </dialog>
  );
}
