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
   *  "submitted" or "streaming") or has errored (status "error") -- i.e.
   *  anything other than "ready". Disables the composer so pressing Enter
   *  mid-stream can't fire a second, overlapping `sendMessage` call (AI
   *  SDK v5's `Chat#sendMessage` has no internal guard against being
   *  called while already in flight or errored -- it just pushes another
   *  message and starts another request). Defaults to false so callers
   *  that don't track a `useChat` status (e.g. a fixture in tests) keep
   *  the composer usable. */
  isSending?: boolean;
  /** #144: set when the owning `useChat`'s last turn failed (status
   *  "error") so a failed/rate-limited stream doesn't just silently
   *  disappear. Rendered as an inline row below the messages with a Retry
   *  action; `onRetry` should call that `useChat` instance's own
   *  `regenerate()`. `null`/`undefined` renders nothing. */
  error?: { message: string; onRetry: () => void } | null;
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
}: ConversationViewProps) {
  const [draft, setDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  /* Scroll to bottom when new messages arrive */
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

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
          {/* Breadcrumb */}
          <p className="breadcrumb" aria-label="Location">{breadcrumb}</p>

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

          {/* Messages */}
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
      </div>

      {/* Sticky composer -- #144: disabled whenever a request is in flight
          or has errored (anything but "ready"), so Enter mid-stream can't
          fire a second, overlapping send. */}
      <Composer
        value={draft}
        onChange={setDraft}
        onSubmit={handleSubmit}
        disabled={isSending}
        history={composerHistory}
      />
    </div>
  );
}

/* Re-export CodeBlock so callers building message content have it available */
export { CodeBlock };
