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
  messages: MessageData[];
  onSendMessage?: (text: string) => void;
}

/* -- Component ------------------------------------------------------------- */

export function ConversationView({
  breadcrumb,
  messages,
  onSendMessage,
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

  return (
    <div className="conversation-column">
      {/* Scrollable message area */}
      <div className="conversation-messages">
        <div className="conversation-inner">
          {/* Breadcrumb */}
          <p className="breadcrumb" aria-label="Location">{breadcrumb}</p>

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

          {/* Bottom sentinel for scroll-to-latest */}
          <div ref={bottomRef} aria-hidden="true" />
        </div>
      </div>

      {/* Sticky composer */}
      <Composer
        value={draft}
        onChange={setDraft}
        onSubmit={handleSubmit}
      />
    </div>
  );
}

/* Re-export CodeBlock so callers building message content have it available */
export { CodeBlock };
