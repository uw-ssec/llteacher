/* --------------------------------------------------------------------------
   Message — a single turn in the conversation.

   Discriminated union on `role`:

   'ai'      — No fill, no border, no speaker label. Pure text at body size.
               The visual differentiation from student messages (no bubble,
               left-aligned) is sufficient — same pattern as Claude / ChatGPT.
               Renders children as-is (may include CodeBlock, paras, etc.)
               When `isStreaming` is true, appends three Heritage Gold dots
               oscillating in a wave.

   'student' — Right-aligned. Soft surface (#F2EFE9). Distinctive asymmetric
               corner radius (16/16/4/16 — bottom-right is the pointing corner).
               max-width 80% of column.

   'system'  — Centered, very small, muted, mono small-caps.
               E.g. "· submitted at 11:34 ·"
   -------------------------------------------------------------------------- */

export type MessageRole = "ai" | "student" | "system";

export interface AIMessageProps {
  role: "ai";
  isStreaming?: boolean;
  children: React.ReactNode;
}

export interface StudentMessageProps {
  role: "student";
  children: React.ReactNode;
}

export interface SystemMessageProps {
  role: "system";
  children: React.ReactNode;
}

export type MessageProps =
  | AIMessageProps
  | StudentMessageProps
  | SystemMessageProps;

export function Message(props: MessageProps) {
  if (props.role === "ai") {
    return (
      <div className="message--ai">
        {/* Message body — no speaker mark; layout difference vs. student
            messages is enough signal */}
        <div className="message__ai-body">
          {props.children}
          {/* Streaming indicator — three Heritage Gold dots in a staggered wave */}
          {props.isStreaming && (
            <span
              className="streaming-dot"
              aria-label="AI is responding"
              role="status"
            >
              <span aria-hidden="true" />
              <span aria-hidden="true" />
              <span aria-hidden="true" />
            </span>
          )}
        </div>
      </div>
    );
  }

  if (props.role === "student") {
    return (
      <div className="message--student">
        <div className="message__student-bubble">
          {props.children}
        </div>
      </div>
    );
  }

  /* system */
  return (
    <div className="message--system" role="status">
      <span className="message__system-text">
        {props.children}
      </span>
    </div>
  );
}
