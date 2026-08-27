/* --------------------------------------------------------------------------
   Composer — the sticky input at the bottom of the conversation column.

   Visual rules:
   - Soft #F6F3ED background, 14px border-radius, no border at rest
   - 1.5px transparent border at rest (reserves space so focus doesn't shift)
   - On focus: 1.5px Heritage Gold border + soft warm halo — semantically
     "the AI is listening"
   - Heritage Gold caret color (the cursor itself carries the AI-voice mark)
   - Branded Husky Purple text selection
   - Placeholder: "Ask, explore, or push back…"
   - Submit via Enter key (Shift+Enter inserts a newline), or the trailing
     action button
   - Bottom-right: muted "enter ↵" hint, fades in on focus, then the trailing
     action button — Send while composing, Stop while a turn streams (#274)
   - Auto-resize via the native `field-sizing: content` CSS property
     with a JS fallback for browsers that don't support it yet.

   Code blocks are written inline using markdown fences — same pattern as
   Claude, ChatGPT, Cursor, Slack, GitHub:

       Here's my code:
       ```r
       flips <- rbinom(100, 1, 0.5)
       sum(flips)
       ```
       Why does it return 47?

   The message renderer detects the fenced block and renders it monospace
   with a Run button (WebR) — no mode switch, no state to remember.

   Controlled component — accepts `value` and `onChange`.

   Shell-style history navigation:
   - Up arrow at the first line walks backward through prior student messages
   - Down arrow at the last line walks forward; past the newest restores the
     in-progress draft (which may be empty)
   - Edits to a recalled message are discarded the next time the user navigates
   - History is supplied by the parent (already-sent messages, oldest→newest)
   -------------------------------------------------------------------------- */

import { useRef, useEffect, useState } from "react";
import { Lightbulb } from "@phosphor-icons/react";
import { Button } from "./Button";

/** #308: matches MAX_TEXT_PART_LENGTH in apps/web/src/server/routes/chat.ts
 *  -- the server refuses a text part longer than this, so capping input
 *  here keeps a normal user from ever composing a message the send would
 *  just reject. */
const DEFAULT_MAX_LENGTH = 8_000;

/** #80 Pitfalls: "Double-submit on UI button ... network retry or user
 *  rapid-click sends duplicates." This is the CLIENT-side half -- a rapid
 *  second click within this window is silently suppressed before
 *  `onRequestHint` is even called, so a mashed button never fires two
 *  requests in the first place. The SERVER-side half (recordHintRequest,
 *  apps/web/src/server/repositories/hints.ts) has its own, longer 2s
 *  idempotency window for the cases this can't catch -- a genuine network
 *  retry after this click already returned, or two separate tabs. */
const HINT_DOUBLE_SUBMIT_SUPPRESS_MS = 1_000;

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  /** Prior student messages, oldest→newest. Up/Down navigate this list. */
  history?: string[];
  /** #235: focuses the textarea once on mount -- used when a brand-new
   *  conversation was just created, so a keyboard user lands where the
   *  visual focus implicitly went (the chat column switched to it)
   *  instead of needing to click/tab into the composer manually. */
  autoFocus?: boolean;
  /** #308: caps how many characters the textarea accepts, matching the
   *  server's own per-text-part limit. */
  maxLength?: number;
  /** #80: renders a "Give me a hint" affordance above the composer when
   *  set -- omitted entirely for a surface with no hint concept (e.g. the
   *  free-standing tutor chat), the same degrade-to-nothing convention
   *  every other optional callback on this component already follows
   *  (history, autoFocus, ...). Calling it sends the hint request through
   *  the SAME send pipeline as a typed message (see App.tsx's
   *  handleSendMessage) -- this button is a convenience trigger, not a
   *  second code path, so nothing here talks to the server directly. */
  onRequestHint?: () => void;
  /** True once the section's hint budget is exhausted (server-driven --
   *  see App.tsx's hint-count state) or a hint request is already in
   *  flight. Disables the button without hiding it, so the affordance
   *  itself stays visible/explorable. */
  hintDisabled?: boolean;
  /** #274 redesign: the streaming Stop handler. When set, the composer's
   *  trailing action button becomes Stop for as long as `isStopActionable`
   *  is true, and reverts to Send afterwards -- the SAME button element
   *  throughout, which is what lets it satisfy #327's requirement that the
   *  control never unmount out from under a keyboard user's focus. Omitted
   *  entirely, the button is only ever Send. */
  onStop?: () => void;
  /** Whether there is genuinely a turn in flight for `onStop` to stop.
   *  False leaves the button in its Send identity. */
  isStopActionable?: boolean;
}

/* Cursor is on the first visual line iff there's no newline before it and no
   selection is active. Mirrors how shells decide to recall history. */
function isAtFirstLine(ta: HTMLTextAreaElement): boolean {
  if (ta.selectionStart !== ta.selectionEnd) return false;
  return !ta.value.slice(0, ta.selectionStart).includes("\n");
}

function isAtLastLine(ta: HTMLTextAreaElement): boolean {
  if (ta.selectionStart !== ta.selectionEnd) return false;
  return !ta.value.slice(ta.selectionEnd).includes("\n");
}

export function Composer({
  value,
  onChange,
  onSubmit,
  disabled = false,
  placeholder = "Ask, explore, or push back…",
  history,
  autoFocus = false,
  maxLength = DEFAULT_MAX_LENGTH,
  onRequestHint,
  hintDisabled = false,
  onStop,
  isStopActionable = false,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /* #80: client-side double-submit suppression -- see
     HINT_DOUBLE_SUBMIT_SUPPRESS_MS's own doc comment above. A ref (not
     state): this is a pure timing guard with nothing to render off of, so
     there's no reason to pay for a re-render on every click. */
  const lastHintRequestAtRef = useRef(0);
  const handleRequestHintClick = () => {
    const now = Date.now();
    if (now - lastHintRequestAtRef.current < HINT_DOUBLE_SUBMIT_SUPPRESS_MS) return;
    lastHintRequestAtRef.current = now;
    onRequestHint?.();
  };

  // #235: run once on mount only (empty deps) -- a later autoFocus prop
  // change must not steal focus back from wherever the user has since
  // moved it.
  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
  }, []);

  /* History navigation state. `historyIndex === null` means the user is on
     their in-progress draft (the bottom of the stack). `savedDraft` preserves
     that draft while the user walks back through history so we can restore it
     when they walk past the newest item. */
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [savedDraft, setSavedDraft] = useState("");

  /* When historyIndex changes, place the cursor at end of the new text so the
     next Up/Down sits at an edge by default — a recalled multi-line message
     lets the user walk up through its lines before reaching further history. */
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const end = ta.value.length;
    ta.setSelectionRange(end, end);
  }, [historyIndex]);

  /* Auto-resize fallback for browsers without field-sizing: content support */
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    /* Only run the resize if field-sizing is unsupported */
    const supported =
      CSS.supports("field-sizing", "content") ||
      CSS.supports("-webkit-field-sizing", "content");
    if (supported) return;

    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, [value]);

  /* Shared by Enter and by the trailing Send button, so the two paths can
     never drift on trimming or on history-slot reset. */
  const canSend = value.trim().length > 0 && !disabled;

  const submitDraft = () => {
    if (!canSend) return;
    onSubmit(value.trim());
    /* Reset history nav so the next message starts on a fresh draft slot */
    setHistoryIndex(null);
    setSavedDraft("");
  };

  /* The trailing button's identity. Stop only while there is genuinely a turn
     to stop; Send the rest of the time. One element, two identities -- never
     two elements swapping places. */
  const stopping = !!onStop && isStopActionable;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitDraft();
      return;
    }

    if (disabled || !history || history.length === 0) return;

    const ta = e.currentTarget;

    if (e.key === "ArrowUp" && isAtFirstLine(ta)) {
      if (historyIndex === null) {
        /* Entering history from the draft slot — stash the draft and jump
           to the newest item. */
        setSavedDraft(value);
        const newIndex = history.length - 1;
        setHistoryIndex(newIndex);
        onChange(history[newIndex]);
        e.preventDefault();
      } else if (historyIndex > 0) {
        const newIndex = historyIndex - 1;
        setHistoryIndex(newIndex);
        onChange(history[newIndex]);
        e.preventDefault();
      }
      /* At index 0 (oldest), Up is a no-op — let the default arrow behavior
         run (which does nothing in a single-line textarea anyway). */
      return;
    }

    if (e.key === "ArrowDown" && isAtLastLine(ta)) {
      if (historyIndex === null) return;
      const newIndex = historyIndex + 1;
      if (newIndex >= history.length) {
        /* Past the newest item — restore the saved draft. */
        setHistoryIndex(null);
        onChange(savedDraft);
      } else {
        setHistoryIndex(newIndex);
        onChange(history[newIndex]);
      }
      e.preventDefault();
    }
  };

  return (
    <div className="composer-zone">
      <div className="composer-inner">
        {/* #80: "Give me a hint" -- omitted entirely (not merely hidden)
            when the surface has no hint concept (App.tsx only passes
            onRequestHint for the homework-section chat, never the
            free-standing tutor chat), same convention hideComposer already
            uses one level up (ConversationView.tsx). Placed above the
            input, not inside composer-body, so it reads as an action ON
            the conversation rather than part of the text-entry row itself. */}
        {onRequestHint && (
          <div className="composer-hint-request">
            <Button
              type="button"
              size="sm"
              outlined
              leadingIcon={<Lightbulb size={14} weight="regular" />}
              onClick={handleRequestHintClick}
              ariaDisabled={hintDisabled || disabled}
              aria-label={hintDisabled ? "Give me a hint (no hints remaining for this section)" : "Give me a hint"}
            >
              Give me a hint
            </Button>
          </div>
        )}
        <div className="composer-wrap">
          <div className="composer-body">
            {/* The textarea — single input mode. Code goes in markdown fences.
                #270: native `disabled` removes the element from the focus
                order the instant it's set -- mid-turn, that's while this
                element already HAS focus, so the browser blurs it to
                `document.body` with nothing to restore it, forcing a
                keyboard-only student to re-traverse the whole page (nav,
                homework sidebar, tutor rail, every conversation row) to
                send their next message. aria-disabled never removes the
                element from that order (focus survives the send/receive
                cycle by construction, nothing to restore), and is announced
                to AT where native `disabled` silently vanishes from the
                accessibility tree -- the WCAG 2.5.8 target-size/AT-visibility
                complaint the original review also raised, fixed as a side
                effect of the same change. readOnly is the actual input
                suppression during streaming; the `!disabled` guard in
                handleKeyDown above still blocks Enter-to-submit too. */}
            <textarea
              ref={textareaRef}
              className="composer-textarea"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              aria-disabled={disabled}
              readOnly={disabled}
              rows={1}
              aria-label="Message input"
              aria-multiline="true"
              maxLength={maxLength}
            />

            {/* Enter hint — fades in on focus via CSS, and fades back out while
                a turn streams, because Enter-to-send is suppressed then
                (handleKeyDown's `canSend` guard) and advertising it would be a
                lie.

                Faded, NOT unmounted. This span is a flex item in
                .composer-body, so removing it also removes its width and one
                `gap` from the row, which widens the flex:1 textarea beside it;
                with `field-sizing: content` a textarea that reflows to a
                different line count changes the composer's height. Streaming
                toggles this state, so unmounting the hint made the composer
                resize mid-generation. Reserving the space keeps the row
                geometry identical in both states. */}
            <span
              className={`composer-hint${stopping ? " composer-hint--suppressed" : ""}`}
              aria-hidden="true"
            >
              enter ↵
            </span>

            {/* #274 redesign: the composer's trailing action. Previously the
                Stop control lived in its own row ABOVE the composer
                (.conversation-stop-row) and Send did not exist at all --
                submission was Enter-only, so there was no pointer or touch
                path to send a message, and the streaming escape hatch floated
                in the transcript's margin detached from the input it belonged
                to.

                One button, two identities, never unmounted: Send while
                composing, Stop while a turn is in flight. That is what makes
                #327's focus guarantee structural rather than incidental --
                pressing Stop morphs the button under the user's focus instead
                of destroying the focused node and mounting a different one.

                aria-disabled (not native `disabled`) for the same #270/#327
                reason the textarea uses it: an empty draft must not silently
                drop this button out of the tab order. */}
            <button
              type="button"
              className={`composer-action${stopping ? " composer-action--stop" : ""}`}
              aria-label={stopping ? "Stop" : "Send"}
              aria-disabled={!stopping && !canSend ? true : undefined}
              onClick={() => {
                if (stopping) {
                  onStop?.();
                  return;
                }
                submitDraft();
              }}
            >
              {/* The stop mark is a drawn box, not the "■" character: a glyph
                  renders well inside its em box at whatever size the font
                  decides, so it came out as a dot in a 32px button. A span with
                  explicit dimensions is predictable and stays optically
                  centred. The arrow stays a glyph -- it fills its box. */}
              {stopping ? (
                <span className="composer-action__stop-mark" aria-hidden="true" />
              ) : (
                <span className="composer-action__glyph" aria-hidden="true">
                  ↑
                </span>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
