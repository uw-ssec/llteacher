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

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Escape fires `cancel` (then `close`) on a native <dialog> -- let the
  // browser's default close proceed, but also tell the parent so its
  // `open` state (the actual source of truth here) stays in sync.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handleCancel = () => onCancel();
    dialog.addEventListener("cancel", handleCancel);
    return () => dialog.removeEventListener("cancel", handleCancel);
  }, [onCancel]);

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
      <div className="alert-dialog__actions">
        <Button variant="default" outlined onClick={onCancel} disabled={confirming}>
          {cancelLabel}
        </Button>
        <Button variant={confirmVariant} onClick={onConfirm} loading={confirming}>
          {confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}
