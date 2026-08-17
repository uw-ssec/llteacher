/* --------------------------------------------------------------------------
   ConversationView — the main conversation column.

   Layout:
     Breadcrumb (mono, top — e.g. "STATS 311 · HW 3 · Section 3 P-VALUES")
     Scrolling message list
     Composer (sticky at bottom)

   Receives a list of messages and renders them via Message.
   The breadcrumb string is passed as a prop.
   -------------------------------------------------------------------------- */

import { useRef, useEffect, useState } from "react";
import { Message } from "./Message";
import { Composer } from "./Composer";
import { CodeBlock } from "./CodeBlock";
import { EditableTitle } from "./EditableTitle";
import { Button } from "./Button";

/* -- Message data shape ---------------------------------------------------- */

export interface AIMessageData {
  id: string;
  role: "ai";
  content: React.ReactNode;
  isStreaming?: boolean;
}

export interface StudentMessageData {
  id: string;
  role: "student";
  content: string;
}

export interface SystemMessageData {
  id: string;
  role: "system";
  content: string;
}

export type MessageData =
  | AIMessageData
  | StudentMessageData
  | SystemMessageData;

/* -- Props ----------------------------------------------------------------- */

export interface ConversationViewProps {
  breadcrumb: string;
  /** #6: the active conversation's own title, shown as an editable heading
   *  below the breadcrumb -- omitted entirely (no heading rendered) for
   *  surfaces with no per-conversation title of their own, e.g. the
   *  homework-section chat, which only ever passes `breadcrumb`. */
  title?: string;
  /** Required alongside `title` to make the heading actually editable --
   *  see EditableTitle's onSave for the resolve/reject contract. */
  onRenameTitle?: (newTitle: string) => void | Promise<void>;
  /** False hides the rename affordance on the header title, matching the
   *  issue's "Only the conversation owner sees the edit affordance".
   *  Defaults to true (every conversation this column ever shows is the
   *  signed-in student's own -- see ConversationListItem's isEditable doc
   *  comment for the same reasoning applied to the list row). */
  isTitleEditable?: boolean;
  messages: MessageData[];
  onSendMessage?: (text: string) => void;
  /** #144: true while the owning `useChat` request is in flight (status
   *  "submitted" or "streaming") -- i.e. a send is genuinely outstanding.
   *  Disables the composer so pressing Enter mid-stream can't fire a
   *  second, overlapping `sendMessage` call (AI SDK v5's `Chat#sendMessage`
   *  has no internal guard against being called while already in flight --
   *  it just pushes another message and starts another request). Defaults
   *  to false so callers that don't track a `useChat` status (e.g. a
   *  fixture in tests) keep the composer usable.
   *
   *  Deliberately does NOT include status "error": `useChat`'s own
   *  `sendMessage` unconditionally resets status to "submitted" and clears
   *  `error` the moment a new message is sent, so sending a fresh message
   *  is the correct way out of a failed turn -- for a `useChat` instance
   *  with no `id` (nothing else ever resets it, e.g. the homework-section
   *  chat), disabling the composer on "error" too would leave Retry (which
   *  replays the exact request that just failed) as the only way out. */
  isSending?: boolean;
  /** #144: set when the owning `useChat`'s last turn failed (status
   *  "error") so a failed/rate-limited stream doesn't just silently
   *  disappear. Rendered as an inline row below the messages with a Retry
   *  action; `onRetry` should call that `useChat` instance's own
   *  `regenerate()`. `null`/`undefined` renders nothing. */
  error?: { message: string; onRetry: () => void } | null;
  /** #235: focuses the composer once on mount -- pass true for the one
   *  render right after a brand-new conversation was created and switched
   *  to, so a keyboard user lands in the composer without an extra Tab. */
  autoFocusComposer?: boolean;
  /** #280: true when the fetched history came back a full page (the
   *  messages route pages at 200, no "load older" is wired yet) -- renders
   *  a static notice above the transcript so the ceiling is visible rather
   *  than silent (a conversation with exactly 200 messages is otherwise
   *  indistinguishable from one truncated at 200). */
  hasMoreHistory?: boolean;
  /** #248: optional slot rendered alongside the breadcrumb for
   *  surface-specific header actions -- e.g. the homework-section chat's
   *  "Restart section" button. `undefined` renders nothing, so surfaces
   *  with no header action (the tutor chat) are unaffected. */
  headerActions?: React.ReactNode;
  /** #274: the owning `useChat` instance's own `stop()` -- rendered as a
   *  "Stop" affordance next to the composer while `isSending` is true.
   *  `undefined` renders nothing (matches every other optional-callback
   *  prop here), so a caller that doesn't track a `useChat` instance (e.g.
   *  a fixture in tests) is unaffected. The server-side half of #274 (a
   *  timeout on the model call itself) already exists (chat.ts's
   *  STREAM_TIMEOUT_MS); this is the client's own escape hatch for a
   *  request that's merely slow, not yet timed out. */
  onStop?: () => void;
}

/* -- Component ------------------------------------------------------------- */

export function ConversationView({
  breadcrumb,
  title,
  onRenameTitle,
  isTitleEditable = true,
  messages,
  onSendMessage,
  isSending = false,
  error = null,
  autoFocusComposer = false,
  hasMoreHistory = false,
  headerActions,
  onStop,
}: ConversationViewProps) {
  const [draft, setDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  /* Scroll to bottom when new messages arrive */
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // #317 review, #327: no deterministic announcement existed for a
  // streamed reply *finishing* -- the start is announced (Message.tsx's
  // own "AI is responding" aria-busy row), but the end relied entirely on
  // aria-busy clearing, whose replay behavior across AT is unspecified
  // (Cordero's own finding: "a blind student hears 'AI is responding' then
  // silence" is a plausible outcome, not a hypothetical one). A static,
  // deterministic phrase -- not the reply's own text -- is used
  // deliberately: `msg.content` is `React.ReactNode` (markdown-rendered,
  // may include a CodeBlock or a generative-UI card), not always a string
  // this component could safely re-read as plain text without risking a
  // garbled or incomplete announcement.
  // Counted, not just a static string: a role="status" region is expected
  // to announce on any mutation regardless of whether the new text matches
  // the old, but that's exactly the AT-dependent behavior this issue's own
  // "manual AT verification" requirement flags as unconfirmed -- appending
  // the turn count keeps consecutive completions textually distinct
  // (and, as a side effect, informative) rather than relying on that
  // assumption holding.
  const [turnCompleteAnnouncement, setTurnCompleteAnnouncement] = useState("");
  const completedTurnCountRef = useRef(0);
  const wasSendingRef = useRef(isSending);
  useEffect(() => {
    if (wasSendingRef.current && !isSending) {
      completedTurnCountRef.current += 1;
      setTurnCompleteAnnouncement(`Response complete (turn ${completedTurnCountRef.current}).`);
    }
    wasSendingRef.current = isSending;
  }, [isSending]);

  const handleSubmit = (text: string) => {
    onSendMessage?.(text);
    setDraft("");
  };

  /* Composer history: the student's most recent 10 sent messages, oldest→newest.
     Derived from the conversation messages already in props — no separate store. */
  const composerHistory = messages
    .filter((m): m is StudentMessageData => m.role === "student")
    .map((m) => m.content)
    .slice(-10);

  return (
    <div className="conversation-column">
      {/* Scrollable message area */}
      <div className="conversation-messages">
        <div className="conversation-inner">
          {/* #317 review, #327: moved OUT of the role="log" region below --
              this row (and the title/hasMoreHistory notice under it) used
              to sit INSIDE it, so App.tsx's #248 Restart button was
              announced as a node ADDITION the moment an eager section
              greeting landed, and every section switch queued the whole
              breadcrumb/title/notice as "new" log content alongside the
              200 fetched messages. None of this is conversation TURN
              content -- role="log" now wraps only the messages themselves. */}
          <div className="conversation-header-row">
            <p className="breadcrumb">{breadcrumb}</p>
            {headerActions}
          </div>

          {/* #6: conversation header title -- only for surfaces that pass
              one (the homework-section chat has no per-conversation title
              and omits `title` entirely, so nothing renders here for it). */}
          {title !== undefined && onRenameTitle && (
            <h1 className="conversation-header-title">
              <EditableTitle
                value={title}
                onSave={onRenameTitle}
                isEditable={isTitleEditable}
                renameLabel="Rename conversation"
              />
            </h1>
          )}

          {/* #280: the ceiling made visible instead of silent -- see
              hasMoreHistory's own doc comment above. No message count in
              the copy: `messages` here keeps growing as the conversation
              continues after hydration, so a count captured from the
              fetched page would go stale the moment a new turn is sent. */}
          {hasMoreHistory && (
            <p className="conversation-history-notice">
              Showing the most recent messages. Older messages aren't shown yet.
            </p>
          )}

          {/* #300: role="log" is the ARIA role specified for exactly this
              case -- a sequence of items where new ones append at the end
              (vs. role="status"/"alert" for a single replaceable message).
              aria-relevant="additions" (not the "additions text" default)
              means only a newly APPENDED node is announced, not every text
              mutation inside an existing one -- combined with aria-busy on
              the in-progress AI message (Message.tsx), a streaming reply is
              silent while it fills in and announced once, whole, on
              completion.

              #317 review, #327: wraps ONLY the appended turns now (the
              breadcrumb/title/notice above moved out, see their own
              comment). Bulk hydration/section-switch replacement is
              handled at the CALLER: App.tsx keys the section
              ConversationView by section id (the tutor surface was
              already keyed by conversationId) so a switch remounts this
              whole component -- including this region -- instead of
              diffing up to 200 messages into a persistent live region as
              node insertions. A freshly-mounted live region has nothing to
              retroactively announce; only genuinely incremental appends
              during an ACTIVE conversation reach an AT as insertions. */}
          <div className="conversation-log" role="log" aria-live="polite" aria-relevant="additions">
            {messages.map((msg) => {
              if (msg.role === "ai") {
                return (
                  <Message key={msg.id} role="ai" isStreaming={msg.isStreaming}>
                    {msg.content}
                  </Message>
                );
              }
              if (msg.role === "student") {
                return (
                  <Message key={msg.id} role="student">
                    {msg.content}
                  </Message>
                );
              }
              return (
                <Message key={msg.id} role="system">
                  {msg.content}
                </Message>
              );
            })}

            {/* #144: inline retryable error row -- shown when the owning
                useChat's last turn failed (status "error"), so a failed or
                rate-limited stream surfaces something instead of the
                synthetic "thinking" placeholder just vanishing. */}
            {error && (
              <div className="conversation-error-row" role="alert">
                <p className="conversation-error-row__message">{error.message}</p>
                <Button variant="danger" size="sm" outlined onClick={error.onRetry}>
                  Retry
                </Button>
              </div>
            )}

            {/* Bottom sentinel for scroll-to-latest */}
            <div ref={bottomRef} aria-hidden="true" />
          </div>

          {/* #317 review, #327: deterministic "the reply is done" signal --
              see turnCompleteAnnouncement's own doc comment above for why
              this is a fixed phrase, not the reply's own text. */}
          <p className="sr-only" role="status">
            {turnCompleteAnnouncement}
          </p>
        </div>
      </div>

      {/* #274: a Stop affordance for a turn that's merely slow, not yet
          timed out (chat.ts's own STREAM_TIMEOUT_MS bounds the server side
          of this).
          #317 review, #327: stays MOUNTED whenever the caller tracks a
          useChat instance to stop (onStop set) -- previously conditional
          on `isSending` too, so a keyboard user who activated Stop had it
          unmount out from under their focus the instant `isSending`
          flipped false, stranding them at document.body with no handoff
          (same harm Composer.tsx's #270 fix already closed for the
          composer). `ariaDisabled` (Button.tsx) keeps it focusable and
          merely refuses activation while nothing is in flight, instead of
          native `disabled` removing it from the tab order. */}
      {onStop && (
        <div className="conversation-stop-row">
          <Button variant="danger" size="sm" outlined onClick={onStop} ariaDisabled={!isSending}>
            Stop
          </Button>
        </div>
      )}

      {/* Sticky composer -- #144: disabled while a send is genuinely in
          flight, so Enter mid-stream can't fire a second, overlapping
          send (see isSending's doc comment above for why "error" is
          deliberately excluded). */}
      <Composer
        value={draft}
        onChange={setDraft}
        onSubmit={handleSubmit}
        disabled={isSending}
        history={composerHistory}
        autoFocus={autoFocusComposer}
      />
    </div>
  );
}

/* Re-export CodeBlock so callers building message content have it available */
export { CodeBlock };
