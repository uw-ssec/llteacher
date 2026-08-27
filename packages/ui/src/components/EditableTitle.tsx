import { useEffect, useId, useRef, useState } from "react";
import { PencilSimple, X } from "@phosphor-icons/react";

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

   #295: `onActivateValue` turns the value span into a real, sibling
   `<button>` -- for a caller like ConversationListItem that used to make
   its OWN wrapper a `role="button"` div containing this component's pencil
   button. ARIA 1.2 defines role="button" as Children Presentational: True
   and normatively prohibits interactive descendants; a real nested
   <button> is exactly the case that rule exists to prevent, and user
   agents prune that subtree -- the pencil's role/name were not reliably
   exposed to AT. With `onActivateValue` supplied, the row's own "select
   this conversation" affordance moves onto the title text itself (a real
   button), leaving two adjacent buttons (title, pencil) with no nesting
   and no ARIA violation. Omitting `onActivateValue` keeps the plain,
   non-interactive `<span>` behavior every existing caller (e.g. the chat
   column header) still wants.

   #298: exiting edit mode (save success, save failure, Escape) restores
   focus to whichever trigger opened it -- the pencil button, or (when
   present) the activate button for the `isEditable === false` case is
   moot since there's no trigger at all there. Without this, all three
   exit paths unmount the focused input and drop focus to <body>,
   forcing a full keyboard re-traversal of the page.
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
  /** #295: when provided, the value renders as a real `<button>` (a
   *  sibling of the pencil button, never its ancestor) that calls this on
   *  click/keyboard-activation instead of doing nothing. Omit to keep the
   *  value as plain, non-interactive text. */
  onActivateValue?: () => void;
  /** aria-label for the value button. Required in practice whenever
   *  `onActivateValue` is passed (falls back to the bare `value` text
   *  otherwise, which is rarely a good accessible name on its own). */
  activateLabel?: string;
  /** Optional aria-describedby target for the value button (e.g. a
   *  sibling block carrying timestamp/count metadata). */
  activateDescribedBy?: string;
  /** Sets aria-current="true" on the value button -- e.g. "this is the
   *  currently-selected/open conversation." */
  isActive?: boolean;
}

/** #310: how close to `maxLength` the input gets before the counter shows.
 *  Small enough that a normal title never sees it. */
const COUNTER_VISIBLE_WITHIN = 20;

export function EditableTitle({
  value,
  onSave,
  maxLength = 100,
  isEditable = true,
  error,
  className = "",
  renameLabel = "Rename",
  onActivateValue,
  activateLabel,
  activateDescribedBy,
  isActive,
}: EditableTitleProps) {
  const counterId = useId();
  const hintId = useId();
  const [isEditing, setIsEditing] = useState(false);
  const [pendingValue, setPendingValue] = useState(value);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // #298: the trigger that opened edit mode -- restored on exit.
  const pencilRef = useRef<HTMLButtonElement>(null);
  const wasEditingRef = useRef(false);
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

  // #298: focus the input on entry; on exit (save/fail/Escape), restore
  // focus to the pencil that opened it rather than letting it fall to
  // <body> when React unmounts the (still-focused) input.
  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
    } else if (wasEditingRef.current) {
      pencilRef.current?.focus();
    }
    wasEditingRef.current = isEditing;
  }, [isEditing]);

  if (!isEditable) {
    if (onActivateValue) {
      return (
        <button
          type="button"
          className={`editable-title__value ${className}`.trim()}
          onClick={onActivateValue}
          aria-label={activateLabel}
          aria-describedby={activateDescribedBy}
          aria-current={isActive ? "true" : undefined}
        >
          {value}
        </button>
      );
    }
    return <span className={`editable-title__text ${className}`.trim()}>{value}</span>;
  }

  const handleEdit = () => {
    setIsEditing(true);
    setPendingValue(value);
    setLocalError(null);
  };

  /* #310: how much room is left, and whether to say so. Silent until the
     last 20 characters so it is not noise on a three-word title, then
     present before the limit bites rather than after. `remaining` can go
     negative now that the native clamp is gone -- that is the point: an
     over-long paste is visible and refused on save instead of silently
     truncated into something the student did not write. */
  /* #395: the TRIMMED length, matching what commitSave validates. Counting
     the raw draft meant a 10-character title followed by three spaces read
     "3 over" in red and then saved successfully -- guidance contradicting
     the rule it exists to describe. */
  const remaining = maxLength - pendingValue.trim().length;
  const showCounter = remaining <= COUNTER_VISIBLE_WITHIN;

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

  /* #291: a failed rename set localError and closed edit mode in the same
     pass, and nothing ever reset it -- so the message stayed beside the row
     permanently, with the only escape being to re-open the editor. Worse, the
     string is the SERVER's (useTutorConversations prefers it), so a rename
     against a conversation deleted elsewhere left "Conversation not found"
     parked next to a student's own chat: vocabulary that reads as a system
     fault for something they did nothing wrong in.
  
     Dismissible, and it clears itself the moment the student does anything
     else with the row -- but it does NOT auto-expire on a timer, because an
     error that vanishes on its own is one the student may never have read. */
  const dismissError = () => setLocalError(null);

  if (!isEditing) {
    return (
      <span className={`editable-title ${className}`.trim()}>
        {/* #295: a real, sibling <button> when the caller wants the value
            itself to be an activation control (e.g. "select this
            conversation") -- never an ancestor of the pencil button below,
            which would reproduce the role="button"-with-nested-button ARIA
            violation this redesign exists to remove. Plain, non-interactive
            text otherwise. */}
        {onActivateValue ? (
          <button
            type="button"
            className="editable-title__value"
            onClick={() => {
              dismissError();
              onActivateValue();
            }}
            aria-label={activateLabel}
            aria-describedby={activateDescribedBy}
            aria-current={isActive ? "true" : undefined}
          >
            {value}
          </button>
        ) : (
          <span className="editable-title__value">{value}</span>
        )}
        <button
          ref={pencilRef}
          type="button"
          className="editable-title__pencil-btn"
          onClick={(e) => {
            // Renaming and "select this row" (a likely sibling activate
            // button in list contexts) are separate interactions -- never
            // let this bubble into one.
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
            {localError && (
              <button
                type="button"
                className="editable-title__error-dismiss"
                onClick={dismissError}
                aria-label="Dismiss rename error"
              >
                <X size={11} weight="bold" aria-hidden="true" />
              </button>
            )}
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
        aria-label="Edit title"
        /* #405: the hint is DESCRIBED, not hidden. It carried
           aria-hidden="true" and the input's only accessible name is "Edit
           title", so the keybindings -- including blur-to-save, the whole
           point of #394 -- reached no screen-reader user at all. My comment
           justified the hiding by claiming "the same information reaches
           assistive tech through the input's own label and behaviour",
           which was simply false.

           Order matters: hint first, then the counter when present.
           aria-describedby is announced on focus, so the static hint should
           lead; the counter is appended only when it is close to relevant. */
        aria-describedby={showCounter ? `${hintId} ${counterId}` : hintId}
        disabled={isSubmitting}
      />
      {/* #310: the native `maxLength` attribute is gone. It clamped typing
          AND pasting with no signal whatsoever -- the input simply stopped
          accepting characters, which reads as a broken field rather than a
          limit. It also made this component's own "Title must be N
          characters or fewer" branch unreachable: EditableTitle.test.tsx
          had to call input.removeAttribute("maxlength") to test it, which
          is a test proving the production path was dead.

          Replaced by a counter that appears only near the limit (silent
          until it is nearly relevant, then present before it bites) with
          the existing validation branch left to refuse an over-long title
          on save -- now genuinely reachable. Pasting a 400-character title
          is now visible and explained rather than silently truncated to
          100, which would have saved something the student did not
          write. */}
      {/* #310: rename mode bound Enter to save, Escape to cancel, AND blur to
          save -- three keyboard conventions with no discoverable surface at
          all. Blur-saves in particular is silent and surprising: clicking
          away from a half-edited title committed it. The rail is 220px, too
          narrow for explicit check/x buttons beside a text field, so this
          takes the hint route the composer already established for its own
          Enter binding.

          #394: the first version said only "enter ↵ · esc to cancel" --
          disclosing the two bindings a user could already guess and omitting
          the one #310 named as surprising. Clicking away commits, which is
          not what most editors do, so it is the binding that most needs
          saying.

          #405: and it was aria-hidden, which meant none of it reached a
          screen-reader user -- the input's only accessible name is "Edit
          title". The justification written here was that "the same
          information reaches assistive tech through the input's own label
          and behaviour", which was false as written. It is referenced by
          aria-describedby now. Blur-to-save is MORE surprising when you
          cannot see the field, not less, so this is the audience that
          needed it most. */}
      <span className="editable-title__hint" id={hintId}>
        enter ↵ or click away saves · esc cancels
      </span>
      {showCounter && (
        <span
          id={counterId}
          className={
            remaining < 0 ? "editable-title__counter editable-title__counter--over" : "editable-title__counter"
          }
          // Not role="status": this updates on every keystroke, and an
          // assertive-ish live region firing per character is unusable.
          // aria-describedby on the input carries it on demand instead.
        >
          {remaining >= 0 ? `${remaining} left` : `${-remaining} over`}
        </span>
      )}
      {displayError && (
        <span className="editable-title__error" role="alert">
          {displayError}
        </span>
      )}
    </span>
  );
}
