/* --------------------------------------------------------------------------
   CodeBlock — monospace code display with optional R output slot.

   Visual rules:
   - Thin top and bottom border rules (no rounded corners)
   - Warm code surface (#F4F1EA) with darker output surface (#EDE9DF)
   - Language label in tiny mono small-caps at top-right
   - "OUTPUT" label in same treatment over the output zone
   - No card frame, no shadow

   Props:
     lang    — language identifier (e.g. "r", "python", "js"). Displayed as label.
     output  — optional R/REPL execution output string to render below the code.
     children — the code string (rendered in a <pre><code>)
   -------------------------------------------------------------------------- */

export interface CodeBlockProps {
  /** Language identifier — shown as top-right label */
  lang?: string;
  /** Optional execution output to render in the output zone */
  output?: string;
  children: string;
}

export function CodeBlock({ lang, output, children }: CodeBlockProps) {
  const langLabel = lang ? lang.toUpperCase() : null;

  return (
    <div className="code-block" aria-label={lang ? `${lang} code block` : "Code block"}>
      {/* Header — language label */}
      {langLabel && (
        <div className="code-block__header">
          <span className="code-block__lang">{langLabel}</span>
        </div>
      )}

      {/* Code */}
      <pre className="code-block__pre">
        <code>{children}</code>
      </pre>

      {/* Output zone — shown only when output prop is provided */}
      {output !== undefined && (
        <div className="code-block__output" aria-label="Execution output">
          <div className="code-block__output-header">
            <span className="code-block__output-label">Output</span>
          </div>
          <pre className="code-block__output-pre">{output}</pre>
        </div>
      )}
    </div>
  );
}
