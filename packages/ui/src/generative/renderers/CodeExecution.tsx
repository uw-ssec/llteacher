import { useEffect, useRef, useState, type ReactNode } from "react";
import { CodeBlock } from "../../components/CodeBlock";

/* --------------------------------------------------------------------------
   CodeExecution — a runnable R code block (#28).

   Two call sites share this one component:
     1. render.tsx's tool-executeRCode dispatch -- the tutor showing the
        student a snippet to try (the model's own generative-UI display
        tool, mirroring DefinitionCard/tool-showDefinition).
     2. renderTextWithCode below -- an R-language fenced block ("```r")
        found directly in a message's own text, which is how the student's
        OWN code reaches the transcript (Composer writes plain markdown
        text; there is no separate "R-mode" message shape to submit -- see
        this file's own doc comment on that decision).

   Deliberately dumb about *how* code gets executed: `onRun` is injected by
   the app layer (apps/web/src/client/hooks/useRExecution.ts's `run`), not
   imported here -- packages/ui is a design-system package with no
   business owning a WebR singleton or knowing this app's persistence
   rules (e.g. whether a given run's result should also be sent back into
   the conversation -- App.tsx's call, not this component's). `onRun`
   undefined is a first-class state, not an error: it degrades to a
   read-only code block with no Run affordance (#28 "graceful degradation"
   requirement) rather than a broken button, e.g. before the app layer has
   wired anything up at all.

   Plot capture: canvas vs. <img> (#28 explicitly leaves this open --
   "decide and document it").

   Decision: draw straight to a <canvas> via CanvasRenderingContext2D's
   drawImage, fed by WebR's own ImageBitmap objects (webr::canvas device).
   Matches the Django reference implementation
   (static/js/r-execution-manager.js's displayResults) exactly, and skips a
   PNG-encode round trip (toDataURL/toBlob) that would buy nothing here: a
   plot is display-only within this one render -- #28 requirement 4 only
   replays CODE + TEXT OUTPUT into the LLM's context (see
   apps/web/src/client/App.tsx's persistExecutionResult), never images,
   since a text-only model can't see them either way. There is no
   serialization boundary a data: URI would actually need to cross.
   -------------------------------------------------------------------------- */

export interface RCodeResult {
  status: "success" | "error";
  /** stdout/stderr captured during execution, or the last expression's own
   *  printed value if nothing was explicitly printed. Absent (not empty
   *  string) when the code produced genuinely no output. */
  output?: string;
  /** Present only when status is "error" -- an R-level error, or this
   *  app's own "R isn't available" / "Timeout" message. */
  error?: string;
  executionTimeMs: number;
  /** Captured plots (webr::canvas device), one ImageBitmap per plot() call. */
  images?: ImageBitmap[];
}

export interface CodeExecutionProps {
  code: string;
  /** Whether to render the code itself alongside any result. Default true
   *  -- matches ExecuteRCodeInput.showSource (#28's Key types). */
  showSource?: boolean;
  /** True while the model's tool-call args are still streaming in (no code
   *  to run yet) -- matches DefinitionCard's own isPartial. */
  isPartial?: boolean;
  onRun?: (code: string) => Promise<RCodeResult>;
}

type RunState = { phase: "idle" } | { phase: "running" } | { phase: "done"; result: RCodeResult };

function Plot({ image }: { image: ImageBitmap }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = image.width;
    canvas.height = image.height;
    canvas.getContext("2d")?.drawImage(image, 0, 0);
  }, [image]);
  return <canvas ref={canvasRef} className="code-execution__plot" role="img" aria-label="R plot output" />;
}

function runButtonLabel(phase: RunState["phase"]): string {
  if (phase === "running") return "Running…";
  return "Run";
}

export function CodeExecution({ code, showSource = true, isPartial, onRun }: CodeExecutionProps) {
  const [state, setState] = useState<RunState>({ phase: "idle" });

  const handleRun = () => {
    if (!onRun || state.phase === "running") return;
    setState({ phase: "running" });
    // useRExecution's `run` never rejects (every failure resolves to
    // status: "error" instead) -- no .catch needed to keep `state` from
    // getting stuck at "running" on a thrown promise.
    void onRun(code).then((result) => setState({ phase: "done", result }));
  };

  if (isPartial) {
    return <CodeBlock lang="r">{code}</CodeBlock>;
  }

  const successOutput = state.phase === "done" && state.result.status === "success" ? (state.result.output ?? "(no output)") : undefined;
  const isError = state.phase === "done" && state.result.status === "error";
  const images = state.phase === "done" ? state.result.images : undefined;

  return (
    <div className="code-execution" data-status={state.phase}>
      {showSource ? (
        <CodeBlock lang="r" output={successOutput}>
          {code}
        </CodeBlock>
      ) : (
        successOutput !== undefined && <pre className="code-block__output-pre">{successOutput}</pre>
      )}

      {isError && (
        <div className="code-execution__error" role="alert">
          <span className="code-execution__error-label">Error</span>
          <pre className="code-execution__error-pre">{state.result.error}</pre>
        </div>
      )}

      {images && images.length > 0 && (
        <div className="code-execution__plots">
          {images.map((image, i) => (
            <Plot key={i} image={image} />
          ))}
        </div>
      )}

      {onRun ? (
        <button
          type="button"
          className="code-execution__run"
          onClick={handleRun}
          disabled={state.phase === "running"}
        >
          {runButtonLabel(state.phase)}
        </button>
      ) : (
        <p className="code-execution__unavailable">R execution isn&apos;t available here.</p>
      )}
    </div>
  );
}

/* -- Fenced-code detection for freeform message text ----------------------

   Composer.tsx's own doc comment: code blocks are written inline using
   markdown fences ("```r ... ```"), the same convention as Claude/ChatGPT/
   Cursor/Slack/GitHub -- there is no separate R-mode toggle or message
   shape for the client to submit. This is what actually detects those
   fences (in either an assistant's own response text, or a student's own
   composed message) and swaps the fenced segment for a runnable
   CodeExecution card instead of plain text.

   Deliberately scoped to fences explicitly tagged "r"/"R" -- not bare
   untagged ```...``` blocks -- so a JSON/shell example the model or
   student pastes for illustration doesn't get offered a Run button that
   would just fail against the R interpreter. */
const R_FENCE_RE = /```[rR]\r?\n([\s\S]*?)```/g;

export interface RenderTextWithCodeOptions {
  onRun?: (code: string) => Promise<RCodeResult>;
  /** Prefix for the React keys of the segments this produces -- callers
   *  pass something unique per message (e.g. the message id) since a
   *  single message's text can contain more than one fenced block. */
  keyPrefix: string;
}

/** Splits `text` on R-language fences, returning an array of `<p>` (plain
 *  text) and `<CodeExecution>` (runnable code) nodes in original order.
 *  Returns a single-element array (`[<p>{text}</p>]`) when no fence is
 *  present, matching how a plain text part rendered before this existed. */
/** The fence split on its own, with no opinion about how the non-code parts
 *  should render. renderTextWithCode below turns the text segments into <p>;
 *  the student's own turn (Message.tsx) needs them kept verbatim in a
 *  pre-wrap span instead, because a student typing "5 * 3 * 2" must get their
 *  asterisks back, and .trim()/<p> would also drop the line breaks they
 *  deliberately typed. One splitter, two presentations. */
export type RCodeSegment = { type: "text" | "code"; value: string };

export function splitRCodeSegments(text: string): RCodeSegment[] {
  const segments: RCodeSegment[] = [];
  let lastIndex = 0;
  R_FENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = R_FENCE_RE.exec(text)) !== null) {
    const [fullMatch, code] = match;
    if (match.index > lastIndex) {
      segments.push({ type: "text", value: text.slice(lastIndex, match.index) });
    }
    segments.push({ type: "code", value: (code ?? "").replace(/\r?\n$/, "") });
    lastIndex = match.index + fullMatch.length;
  }
  if (lastIndex < text.length) {
    segments.push({ type: "text", value: text.slice(lastIndex) });
  }
  return segments;
}

export function renderTextWithCode(text: string, options: RenderTextWithCodeOptions): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let segmentIndex = 0;
  R_FENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = R_FENCE_RE.exec(text)) !== null) {
    const [fullMatch, code] = match;
    if (match.index > lastIndex) {
      const before = text.slice(lastIndex, match.index).trim();
      if (before) nodes.push(<p key={`${options.keyPrefix}-t${segmentIndex}`}>{before}</p>);
    }
    nodes.push(
      <CodeExecution key={`${options.keyPrefix}-c${segmentIndex}`} code={code.replace(/\r?\n$/, "")} onRun={options.onRun} />,
    );
    lastIndex = match.index + fullMatch.length;
    segmentIndex += 1;
  }
  const rest = text.slice(lastIndex).trim();
  if (rest) nodes.push(<p key={`${options.keyPrefix}-t${segmentIndex}`}>{rest}</p>);
  if (nodes.length === 0) return [<p key={`${options.keyPrefix}-t0`}>{text}</p>];
  return nodes;
}
