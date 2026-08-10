import { useEffect, useRef, useState } from "react";
import { PencilSimple } from "@phosphor-icons/react";

/* --------------------------------------------------------------------------
   EditableTitle — inline click-to-rename primitive (#6).

   The shared component behind "click a pencil icon next to a title, get an
   inline text input" wherever it shows up in the app: the tutor-
   conversations list row (ConversationListItem) and the tutor chat
   column's header. Both callers own their own persistence (an onSave that
   PATCHes and reconciles/reverts optimistic state) -- this component only
   owns the *local* edit-mode UI: entering/exiting edit mode, the input's
   value, client-side validation, in-flight/disabled state, and surfacing
   whatever onSave does.

   #6 redesign (post-review): the title TEXT itself is no longer the rename
   trigger -- it's plain, non-interactive display text. A small, dedicated
   pencil-icon button next to it is the ONLY way to enter edit mode. This
   reverses the first version of this component, where clicking the whole
   title (text + icon, one button) entered edit mode -- which meant the
   list row could no longer use a click on its title to select the
   conversation (that's #4's original, and now restored, contract: click
   the row/title selects; a separate pencil renames). See
   ConversationListItem's doc comment for how the list row's outer
   click-to-select and this component's nested pencil button coexist
   without a nested-<button> HTML violation.

   Two distinct error paths, matching the issue's two separate requirement
   lines ("show inline guidance for invalid input" vs "on failure, revert
   and show inline error"):
     - Client-side validation (empty-after-trim, over maxLength) never
       calls onSave at all -- it shows an error and STAYS in edit mode so
       the student doesn't lose what they typed and can just fix it.
     - A rejected onSave (network/server failure) is terminal for this
       attempt: the input reverts to the last known-good `value` and edit
       mode closes, with the error left visible next to the (reverted)
       read-only title. This matches Pitfall #1 in the issue's Code
       Framework ("on rejection, the component reverts pendingValue to
       value") and Testing Strategy #2 ("UI reverts to the old title AND
       shows inline error").

   Owner-only: when `isEditable` is false, this renders inert text with no
   pencil button at all (not a disabled one) -- a non-owner should not even
   discover a rename affordance exists, matching the issue's "Only the
   conversation owner sees the edit affordance."
   -------------------------------------------------------------------------- */

export interface EditableTitleProps {
  value: string;
  /** Persists the trimmed new title. Reject to signal failure -- see the
   *  doc comment above for how that's surfaced. */
  onSave: (newTitle: string) => void | Promise<void>;
  maxLength?: number;
  /** False hides the rename affordance entirely (non-owner). Default true. */
  isEditable?: boolean;
  /** Optional externally-supplied error, shown alongside (behind) any
   *  locally-generated one -- for a caller that wants to surface a error
   *  from somewhere other than this component's own onSave call. */
  error?: string;
  className?: string;
  /** aria-label prefix for the pencil rename trigger, e.g. "Rename". */
  renameLabel?: string;
}

export function EditableTitle({
  value,
  onSave,
  maxLength = 100,
  isEditable = true,
  error,
  className = "",
  renameLabel = "Rename",
}: EditableTitleProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [pendingValue, setPendingValue] = useState(value);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Set right before we know the input is about to leave the DOM (a
  // successful or failed commitSave, or Escape) -- removing a focused
  // element from the DOM fires a real "blur" event in browsers, which
  // would otherwise re-enter handleBlur and double-submit. Consumed
  // (reset to false) the next time a blur actually happens.
  const suppressNextBlurRef = useRef(false);

  // Keeps the input's draft in sync with a `value` prop change that lands
  // while NOT editing (e.g. another tab / the list's own refetch renamed
  // it) -- so the next time edit mode opens, it's pre-filled with the
  // current title, not a stale one captured at first render.
  useEffect(() => {
    if (!isEditing) setPendingValue(value);
  }, [value, isEditing]);

  useEffect(() => {
    if (isEditing) inputRef.current?.focus();
  }, [isEditing]);

  if (!isEditable) {
    return <span className={`editable-title__text ${className}`.trim()}>{value}</span>;
  }

  const handleEdit = () => {
    setIsEditing(true);
    setPendingValue(value);
    setLocalError(null);
  };

  const commitSave = async () => {
    const trimmed = pendingValue.trim();
    if (!trimmed) {
      setLocalError("Title cannot be empty.");
      return; // client-side validation -- stay in edit mode, don't call onSave
    }
    if (trimmed.length > maxLength) {
      setLocalError(`Title must be ${maxLength} characters or fewer.`);
      return; // client-side validation -- stay in edit mode, don't call onSave
    }

    setLocalError(null);
    setIsSubmitting(true);
    try {
      await onSave(trimmed);
      suppressNextBlurRef.current = true;
      setIsEditing(false);
    } catch (err) {
      setPendingValue(value); // revert -- see doc comment above
      setLocalError(err instanceof Error ? err.message : "Failed to save. Please try again.");
      suppressNextBlurRef.current = true;
      setIsEditing(false);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleBlur = () => {
    if (suppressNextBlurRef.current) {
      suppressNextBlurRef.current = false;
      return;
    }
    // Disabling a focused input (isSubmitting flipping true) also fires a
    // native blur in real browsers -- ignore it, the in-flight commitSave
    // already owns this attempt.
    if (isSubmitting) return;
    void commitSave();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      suppressNextBlurRef.current = true;
      setIsEditing(false);
      setPendingValue(value);
      setLocalError(null);
    } else if (e.key === "Enter") {
      e.preventDefault();
      void commitSave();
    }
  };

  const displayError = localError ?? error;

  if (!isEditing) {
    return (
      <span className={`editable-title ${className}`.trim()}>
        {/* Plain, non-interactive display text -- NOT a click target for
            entering edit mode (see this file's doc comment for why the
            first version of this component had that, and why it changed:
            a list row needs its title click-able for "select this row"
            instead, restoring #4's original contract). */}
        <span className="editable-title__value">{value}</span>
        <button
          type="button"
          className="editable-title__pencil-btn"
          onClick={(e) => {
            // Renaming and "select this row" (a likely ancestor click
            // handler in list contexts) are separate interactions --
            // never let this bubble into one.
            e.stopPropagation();
            handleEdit();
          }}
          aria-label={`${renameLabel}: ${value}`}
        >
          <PencilSimple
            className="editable-title__pencil"
            size={12}
            weight="regular"
            aria-hidden="true"
          />
        </button>
        {displayError && (
          <span className="editable-title__error" role="alert">
            {displayError}
          </span>
        )}
      </span>
    );
  }

  return (
    <span className={`editable-title editable-title--editing ${className}`.trim()}>
      <input
        ref={inputRef}
        type="text"
        className="editable-title__input"
        value={pendingValue}
        onChange={(e) => setPendingValue(e.target.value)}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        onClick={(e) => e.stopPropagation()}
        maxLength={maxLength}
        aria-label="Edit title"
        disabled={isSubmitting}
      />
      {displayError && (
        <span className="editable-title__error" role="alert">
          {displayError}
        </span>
      )}
    </span>
  );
}
