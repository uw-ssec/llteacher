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
   - Submit via Enter key (Shift+Enter inserts a newline)
   - Bottom-right: muted "enter ↵" hint, fades in on focus
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
   -------------------------------------------------------------------------- */

import { useRef, useEffect } from "react";

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function Composer({
  value,
  onChange,
  onSubmit,
  disabled = false,
  placeholder = "Ask, explore, or push back…",
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const trimmed = value.trim();
      if (trimmed && !disabled) {
        onSubmit(trimmed);
      }
    }
  };

  return (
    <div className="composer-zone">
      <div className="composer-inner">
        <div className="composer-wrap">
          <div className="composer-body">
            {/* The textarea — single input mode. Code goes in markdown fences. */}
            <textarea
              ref={textareaRef}
              className="composer-textarea"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              disabled={disabled}
              rows={1}
              aria-label="Message input"
              aria-multiline="true"
            />

            {/* Enter hint — fades in on focus via CSS */}
            <span className="composer-hint" aria-hidden="true">
              enter ↵
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
