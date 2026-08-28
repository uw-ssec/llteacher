import { describe, it, expect } from "vitest";
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  ESTIMATED_CHARS_PER_TOKEN,
  MIN_HISTORY_BUDGET_TOKENS,
  MODEL_CONTEXT_WINDOW_TOKENS,
  PER_MESSAGE_TOKEN_OVERHEAD,
  TOOL_AND_FRAMING_RESERVE_TOKENS,
  contextWindowTokensFor,
  estimateMessageTokens,
  estimateTextTokens,
  resolveHistoryTokenBudget,
  windowMessagesToTokenBudget,
  type BudgetableMessage,
} from "./context-window";
import { assembleSystemPrompt, DEFAULT_SYSTEM_PROMPT } from "./prompts";

/** A message whose estimated cost is a known, exact number of tokens, so the
 *  boundary tests below can be stated in tokens rather than in "about this
 *  many characters". Solves for the text length that makes
 *  estimateMessageTokens return exactly `tokens`. */
function messageCosting(tokens: number, role = "user"): BudgetableMessage {
  const bodyTokens = tokens - PER_MESSAGE_TOKEN_OVERHEAD;
  // JSON.stringify([{"type":"text","text":"..."}]) wraps the text in this
  // many characters of punctuation, which the estimator charges for too.
  const envelope = JSON.stringify([{ type: "text", text: "" }]).length;
  const chars = Math.floor(bodyTokens * ESTIMATED_CHARS_PER_TOKEN) - envelope;
  const msg = { role, parts: [{ type: "text", text: "x".repeat(chars) }] };
  const actual = estimateMessageTokens(msg);
  if (actual !== tokens) throw new Error(`fixture is ${actual} tokens, wanted ${tokens}`);
  return msg;
}

describe("estimateTextTokens (#88)", () => {
  it("overcounts relative to the conventional 4-chars-per-token rule -- the deliberate direction", () => {
    // The asymmetry IS the design (see ESTIMATED_CHARS_PER_TOKEN's own doc
    // comment): overcounting truncates a little more history than strictly
    // necessary, undercounting overflows the window and fails the turn. A
    // change that made this estimator "more accurate" by relaxing to 4.0
    // would silently flip which of those two failure modes this app has.
    const text = "a".repeat(4_000);
    expect(estimateTextTokens(text)).toBeGreaterThan(text.length / 4);
  });

  it("is zero for empty text and monotonic in length", () => {
    expect(estimateTextTokens("")).toBe(0);
    expect(estimateTextTokens("a".repeat(100))).toBeLessThan(estimateTextTokens("a".repeat(200)));
  });
});

describe("estimateMessageTokens (#88 requirement 3: code/tool messages)", () => {
  it("charges a tool part for its real payload, not zero", () => {
    // The requirement this covers: a text-only estimator scores an
    // executeRCode message carrying a 200-line script as nearly free, and
    // then keeps forty of them. The R source is inside the part, not in a
    // `text` field.
    const script = "for (i in 1:100) { print(summary(lm(y ~ x, data = d))) }\n".repeat(40);
    const codeMessage = {
      role: "assistant",
      parts: [{ type: "tool-executeRCode", state: "output-available", input: { code: script } }],
    };
    const emptyMessage = { role: "assistant", parts: [{ type: "tool-executeRCode", state: "output-available", input: { code: "" } }] };

    expect(estimateMessageTokens(codeMessage)).toBeGreaterThan(estimateTextTokens(script));
    expect(estimateMessageTokens(codeMessage)).toBeGreaterThan(estimateMessageTokens(emptyMessage) * 10);
  });

  it("charges every part of a multi-part message, not just the first", () => {
    const one = { role: "assistant", parts: [{ type: "text", text: "y".repeat(1_000) }] };
    const two = {
      role: "assistant",
      parts: [
        { type: "text", text: "y".repeat(1_000) },
        { type: "text", text: "y".repeat(1_000) },
      ],
    };
    expect(estimateMessageTokens(two)).toBeGreaterThan(estimateMessageTokens(one) * 1.9);
  });

  it("charges a short message the per-message overhead rather than ~nothing", () => {
    // Forty turns of "ok"/"why?" is a real Socratic transcript, not a corner
    // case; each one still costs role and framing tokens.
    expect(estimateMessageTokens({ role: "user", parts: [{ type: "text", text: "ok" }] })).toBeGreaterThanOrEqual(
      PER_MESSAGE_TOKEN_OVERHEAD,
    );
  });

  it("charges an unserializable parts value the whole budget instead of treating it as free", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(estimateMessageTokens({ role: "user", parts: cyclic })).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("contextWindowTokensFor (#88: per-model, never hardcoded)", () => {
  it("returns the table's figure for a model it knows", () => {
    expect(contextWindowTokensFor("google/gemma-4-31b-it:free")).toBe(262_144);
    expect(contextWindowTokensFor("google/gemma-4-31b-it:free")).toBe(
      MODEL_CONTEXT_WINDOW_TOKENS["google/gemma-4-31b-it:free"],
    );
  });

  it("falls back to the documented default for an unlisted model", () => {
    expect(contextWindowTokensFor("some-vendor/never-heard-of-it")).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
  });

  it("actually VARIES by model -- the property #88 asks for", () => {
    expect(contextWindowTokensFor("google/gemma-4-31b-it:free")).not.toBe(
      contextWindowTokensFor("gpt-5.3-codex"),
    );
  });

  it("matches exactly, so a small model cannot inherit a large sibling's entry by prefix", () => {
    expect(contextWindowTokensFor("google/gemma-4-31b-it")).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
    expect(contextWindowTokensFor("google/gemma-4-31b-it:free-tiny")).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
  });
});

describe("resolveHistoryTokenBudget (#88 requirement 1: budget math)", () => {
  const sys = "system prompt text";

  it("subtracts the response headroom, the system prompt and the tool reserve from the model's window", () => {
    const budget = resolveHistoryTokenBudget({
      modelNames: ["google/gemma-4-31b-it:free"],
      maxCompletionTokens: 4_000,
      systemPrompt: sys,
    });
    expect(budget).toBe(262_144 - 4_000 - estimateTextTokens(sys) - TOOL_AND_FRAMING_RESERVE_TOKENS);
  });

  it("shrinks as the system prompt grows -- the prompt is charged, not assumed free", () => {
    const small = resolveHistoryTokenBudget({ modelNames: ["m"], maxCompletionTokens: 1_000, systemPrompt: "x" });
    const large = resolveHistoryTokenBudget({
      modelNames: ["m"],
      maxCompletionTokens: 1_000,
      systemPrompt: "x".repeat(40_000),
    });
    expect(large).toBeLessThan(small);
    expect(small - large).toBe(estimateTextTokens("x".repeat(40_000)) - estimateTextTokens("x"));
  });

  it("shrinks as max_completion_tokens grows -- headroom for the answer is real headroom", () => {
    const a = resolveHistoryTokenBudget({ modelNames: ["m"], maxCompletionTokens: 1_000, systemPrompt: sys });
    const b = resolveHistoryTokenBudget({ modelNames: ["m"], maxCompletionTokens: 9_000, systemPrompt: sys });
    expect(a - b).toBe(8_000);
  });

  it("uses the SMALLEST window across the hops that could serve the turn (#364 failover)", () => {
    // chat.ts builds one message array for both hops, so the array has to fit
    // the backup too -- a failover fires precisely when the primary is
    // already down, and overflowing the backup would turn a recoverable
    // outage into a failed turn.
    const primaryOnly = resolveHistoryTokenBudget({
      modelNames: ["google/gemma-4-31b-it:free"],
      maxCompletionTokens: 1_000,
      systemPrompt: sys,
    });
    const withSmallerFallback = resolveHistoryTokenBudget({
      modelNames: ["google/gemma-4-31b-it:free", "unlisted/smaller-model"],
      maxCompletionTokens: 1_000,
      systemPrompt: sys,
    });
    expect(withSmallerFallback).toBeLessThan(primaryOnly);
    expect(withSmallerFallback).toBe(
      DEFAULT_CONTEXT_WINDOW_TOKENS - 1_000 - estimateTextTokens(sys) - TOOL_AND_FRAMING_RESERVE_TOKENS,
    );
  });

  it("falls back to the default window rather than an unbounded one when handed no models", () => {
    // Math.min() of nothing is Infinity -- "no bound at all" is the one
    // direction this module must never fail in, so the empty case is pinned.
    expect(
      resolveHistoryTokenBudget({ modelNames: [], maxCompletionTokens: 1_000, systemPrompt: sys }),
    ).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS - 1_000 - estimateTextTokens(sys) - TOOL_AND_FRAMING_RESERVE_TOKENS);
  });

  it("floors at MIN_HISTORY_BUDGET_TOKENS rather than returning zero or negative", () => {
    // A config whose max_completion_tokens is near its model's whole window
    // is a misconfiguration; serving it faithfully would mean a tutor with
    // no conversational memory at all, every turn, silently.
    const budget = resolveHistoryTokenBudget({
      modelNames: ["unlisted/model"],
      maxCompletionTokens: DEFAULT_CONTEXT_WINDOW_TOKENS * 2,
      systemPrompt: sys,
    });
    expect(budget).toBe(MIN_HISTORY_BUDGET_TOKENS);
  });

  it("a real assembled system prompt still leaves an ordinary conversation entirely intact", () => {
    // Regression guard on the whole feature being too aggressive: the real
    // prompt lib/prompts.ts produces plus a normal 40-message transcript
    // must not truncate at all on a default-window model.
    const systemPrompt = assembleSystemPrompt(DEFAULT_SYSTEM_PROMPT, undefined, true, false, undefined, [
      "showDefinition",
      "executeRCode",
      "requestHint",
      "markSectionComplete",
    ]);
    const budget = resolveHistoryTokenBudget({
      modelNames: ["gpt-5.3-codex"],
      maxCompletionTokens: 4_096,
      systemPrompt,
    });
    const transcript = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      parts: [{ type: "text", text: "A typical Socratic turn, a few sentences long. ".repeat(12) }],
    }));
    expect(windowMessagesToTokenBudget(transcript, budget).droppedCount).toBe(0);
  });
});

describe("windowMessagesToTokenBudget (#88: boundary behaviour)", () => {
  it("keeps everything when the whole history fits", () => {
    const messages = [messageCosting(100), messageCosting(100), messageCosting(100)];
    const result = windowMessagesToTokenBudget(messages, 1_000);
    expect(result.messages).toEqual(messages);
    expect(result.droppedCount).toBe(0);
    expect(result.lastMessageExceedsBudget).toBe(false);
  });

  it("keeps a history that costs EXACTLY the budget -- at-budget fits", () => {
    const messages = [messageCosting(100), messageCosting(100), messageCosting(100)];
    const result = windowMessagesToTokenBudget(messages, 300);
    expect(result.messages).toHaveLength(3);
    expect(result.droppedCount).toBe(0);
  });

  it("drops exactly one message when the history is ONE token over budget", () => {
    // The off-by-one that matters: 299 must not keep all three, and must not
    // over-drop either.
    const messages = [messageCosting(100), messageCosting(100), messageCosting(100)];
    const result = windowMessagesToTokenBudget(messages, 299);
    expect(result.messages).toHaveLength(2);
    expect(result.droppedCount).toBe(1);
    expect(result.messages).toEqual([messages[1], messages[2]]);
  });

  it("drops from the FRONT, keeping the most recent turns", () => {
    const messages = [
      { role: "user", parts: [{ type: "text", text: "OLDEST" }] },
      messageCosting(500),
      { role: "user", parts: [{ type: "text", text: "NEWEST" }] },
    ];
    const result = windowMessagesToTokenBudget(messages, 100);
    expect(JSON.stringify(result.messages)).not.toContain("OLDEST");
    expect(JSON.stringify(result.messages)).toContain("NEWEST");
  });

  it("always keeps the current question, even when it alone exceeds the budget", () => {
    // #88's own stated edge case. Dropping the turn the student just sent
    // would leave the model answering nothing at all.
    const messages = [messageCosting(50), messageCosting(50), messageCosting(5_000)];
    const result = windowMessagesToTokenBudget(messages, 1_000);
    expect(result.messages).toEqual([messages[2]]);
    expect(result.droppedCount).toBe(2);
    expect(result.lastMessageExceedsBudget).toBe(true);
  });

  it("does not set lastMessageExceedsBudget when the last message merely does not leave room for others", () => {
    const messages = [messageCosting(900), messageCosting(900)];
    const result = windowMessagesToTokenBudget(messages, 1_000);
    expect(result.messages).toHaveLength(1);
    expect(result.lastMessageExceedsBudget).toBe(false);
  });

  it("handles an empty history", () => {
    expect(windowMessagesToTokenBudget([], 1_000)).toEqual({
      messages: [],
      droppedCount: 0,
      lastMessageExceedsBudget: false,
    });
  });

  it("handles a zero or negative budget by keeping just the current question", () => {
    const messages = [messageCosting(50), messageCosting(50)];
    expect(windowMessagesToTokenBudget(messages, 0).messages).toEqual([messages[1]]);
    expect(windowMessagesToTokenBudget(messages, -50).messages).toEqual([messages[1]]);
  });

  it("never mutates or reorders the input", () => {
    const messages = [messageCosting(100), messageCosting(100), messageCosting(100)];
    const snapshot = JSON.parse(JSON.stringify(messages));
    windowMessagesToTokenBudget(messages, 150);
    expect(messages).toEqual(snapshot);
  });
});

describe("windowMessagesToTokenBudget: no leakage and no synthesis (#88 requirement 5)", () => {
  it("returns a contiguous SUFFIX of the input -- every kept message is byte-identical to one that went in", () => {
    // The structural guarantee that stands in for "summaries don't leak
    // solutions": this pass builds no summary. Because the output can only
    // ever be a suffix, the windowing step introduces no new text-bearing
    // surface at all, so there is nothing for solution text to flow through
    // that was not already in a persisted message (chat.ts's #143 trust
    // boundary). Same posture as lib/prompts.test.ts's "never includes
    // solution text -- there is no parameter to pass it through".
    const messages = Array.from({ length: 12 }, (_, i) => messageCosting(200, i % 2 === 0 ? "user" : "assistant"));
    const result = windowMessagesToTokenBudget(messages, 1_000);

    const start = messages.length - result.messages.length;
    expect(result.messages).toEqual(messages.slice(start));
    // Referential identity, not just deep equality: nothing was copied,
    // rewritten, re-serialized or re-wrapped on the way through.
    result.messages.forEach((m, i) => expect(m).toBe(messages[start + i]));
  });

  it("emits no synthesized placeholder, note or summary in place of what it dropped", () => {
    const messages = [
      { role: "assistant", parts: [{ type: "text", text: "The model solution is x = 42." }] },
      messageCosting(5_000),
      { role: "user", parts: [{ type: "text", text: "what now?" }] },
    ];
    const result = windowMessagesToTokenBudget(messages, 100);

    const serialized = JSON.stringify(result.messages);
    expect(serialized).not.toContain("x = 42");
    expect(serialized).not.toContain("summary");
    expect(serialized).not.toContain("omitted");
    expect(serialized).not.toContain("earlier");
    expect(result.messages.every((m) => messages.includes(m))).toBe(true);
  });

  it("cannot drop the system prompt, because the system prompt is not in this array", () => {
    // The system-prompt-always-survives invariant is structural: this
    // function's whole input is the message history, and the prompt is
    // charged against the window one level up (resolveHistoryTokenBudget)
    // and passed to streamText as its own `system` option. This test pins
    // the shape that makes that true -- if the prompt ever became an element
    // of the array, it would become droppable and this assertion is what
    // would notice.
    const systemPrompt = assembleSystemPrompt(DEFAULT_SYSTEM_PROMPT, undefined, true);
    const messages = [messageCosting(9_000), { role: "user", parts: [{ type: "text", text: "help" }] }];
    const budget = resolveHistoryTokenBudget({
      modelNames: ["unlisted/model"],
      maxCompletionTokens: 1_000,
      systemPrompt,
    });
    const result = windowMessagesToTokenBudget(messages, Math.min(budget, 100));
    expect(JSON.stringify(result.messages)).not.toContain("Socratic");
    expect(result.messages.every((m) => m.role !== "system")).toBe(true);
  });
});
