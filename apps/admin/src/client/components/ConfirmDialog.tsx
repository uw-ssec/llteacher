/* --------------------------------------------------------------------------
   ConfirmDialog — the console's confirmation modal for destructive actions.

   A native <dialog> opened with showModal(): the browser supplies the
   backdrop, keeps focus inside, makes the rest of the page inert, and
   closes on Escape. Focus lands on Cancel, so a stray Enter never deletes.
   The confirm button is the only destructive-styled control on the page.

   Two optional guards: a checkbox for a secondary consequence ("also delete
   the original upload"), and a phrase to type for the one action the
   console cannot undo.
   -------------------------------------------------------------------------- */

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

export type ConfirmDialogProps = {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  checkbox?: { label: string; checked: boolean; onChange: (checked: boolean) => void };
  /** The exact phrase the instructor must type before confirm enables. */
  typeToConfirm?: string;
  error?: string | null;
  /** "danger" (default) for deletes; "primary" for a consequential but
   *  reversible change, such as setting a default for every course. */
  tone?: "danger" | "primary";
};

export function ConfirmDialog({
  open, title, body, confirmLabel, onConfirm, onCancel, busy = false, checkbox, typeToConfirm, error, tone = "danger",
}: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const phraseId = useId();
  const [typed, setTyped] = useState("");

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open) {
      setTyped("");
      // jsdom has no showModal; the open attribute is the fallback there.
      if (typeof el.showModal === "function") { if (!el.open) el.showModal(); }
      else el.setAttribute("open", "");
      cancelRef.current?.focus();
    } else if (el.open) {
      if (typeof el.close === "function") el.close(); else el.removeAttribute("open");
    }
  }, [open]);

  if (!open) return null;
  const phraseOk = !typeToConfirm || typed === typeToConfirm;

  return (
    <dialog
      ref={ref}
      className="admin-dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onCancel={(e) => { e.preventDefault(); if (!busy) onCancel(); }}
      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); if (!busy) onCancel(); } }}
    >
      <div className="admin-dialog__body">
        <h2 id={titleId} className="admin-dialog__title">{title}</h2>
        <div className="admin-dialog__text">{body}</div>
        {checkbox && (
          <label className="admin-dialog__check">
            <input type="checkbox" checked={checkbox.checked} disabled={busy} onChange={(e) => checkbox.onChange(e.target.checked)} />
            {checkbox.label}
          </label>
        )}
        {typeToConfirm && (
          <label className="admin-dialog__phrase" htmlFor={phraseId}>
            Type {typeToConfirm} to confirm
            <input
              id={phraseId}
              type="text"
              autoComplete="off"
              spellCheck={false}
              className="list-controls__search-input"
              value={typed}
              disabled={busy}
              onChange={(e) => setTyped(e.target.value)}
            />
          </label>
        )}
        {error && <p className="admin-field-error" role="alert">{error}</p>}
        <div className="admin-dialog__actions">
          <button ref={cancelRef} type="button" className="admin-button admin-button--ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className={tone === "danger" ? "admin-button admin-button--danger" : "admin-button admin-button--primary"} disabled={busy || !phraseOk} onClick={onConfirm}>
            {busy ? `${confirmLabel.replace(/e$/, "")}ing…` : confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
