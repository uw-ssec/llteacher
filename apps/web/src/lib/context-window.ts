/* --------------------------------------------------------------------------
   Token-budget management for the assembled prompt (#88).

   BEFORE this module, the only bound on what the model saw was
   `MAX_HISTORY_MESSAGES` (40, shared/chat-limits.ts) -- a flat COUNT of
   trailing messages. A count is not a budget: 40 turns of "yes"/"why?" and 40
   turns each carrying an 8,000-character pasted dataset (both well-formed
   under this route's own MAX_TEXT_PART_LENGTH cap) are the same number and
   differ by two orders of magnitude in tokens. The second one overflows a
   real context window, and the failure mode is a provider-side hard error on
   a student's turn, not a graceful forget.

   This module adds the SECOND, token-aware bound that composes with the
   count. The two are deliberately not merged:

     MAX_HISTORY_MESSAGES  -- the OUTER bound. Applied at the DB read
                              (chat.ts's getLastMessages), so it also bounds
                              how much this request reads and parses at all.
                              It is the number the student sees disclosed
                              (#288's ConversationView divider).
     this module            -- the INNER bound. Applied in memory, after the
                              history is assembled and after the system prompt
                              is known, because the budget depends on both.

   SCOPE (deliberate, see #88's own text): simple, token-aware TRUNCATION --
   the strategy the issue itself names as "the acceptable v1 fallback if
   summarization is deferred". There is NO rolling summary here: nothing in
   this module generates, stores, or versions a summary of the dropped turns,
   and nothing in the schema has a column for one. Older turns are dropped,
   whole and silently, exactly as MAX_HISTORY_MESSAGES already drops them --
   this makes the drop correct with respect to the model's actual window
   rather than a proxy for it. A rolling summary is a separate feature (it
   needs its own storage, its own versioning, its own logging, and its own
   leakage-safety story for summarized solution-adjacent content) and is not
   in this pass.

   CONVERSATION-STABILITY INVARIANT (#30): every function here is pure. The
   budget is derived from the config chat.ts ALREADY resolved once for this
   turn (lib/llm-config.ts's resolveLLMConfig, plus the failover hop it
   already resolved alongside it) -- this module performs no lookup of its
   own, adds no per-message config read, and cannot re-resolve which config a
   conversation is on.
   -------------------------------------------------------------------------- */

/** Characters per token, for the estimator below.
 *
 *  A CHARACTER HEURISTIC, NOT A REAL TOKENIZER -- the fallback #88's own text
 *  explicitly allows ("fallback to character-based heuristic. Conservative
 *  estimate (overcount) is safer than undercount"). The alternative,
 *  `js-tiktoken`, is not a dependency of this app and is a poor fit for it:
 *  this code runs in a Cloudflare Worker (bundle size is a deploy-time
 *  constraint, and the BPE rank tables are megabytes), and the two providers
 *  this deployment actually fronts (OpenRouter, and UW SSEC's LiteLLM
 *  gateway) route to models from several vendors whose tokenizers differ --
 *  so a single bundled tokenizer would be exactly correct for one model and
 *  merely a different approximation for the rest.
 *
 *  3.5, not the conventional 4.0, is the whole point: it OVERCOUNTS by
 *  roughly 15% against English prose. Overcounting truncates slightly more
 *  history than strictly necessary (a graceful, invisible degradation);
 *  undercounting overflows the window and fails the student's turn outright.
 *  The asymmetry is the reason for the number. */
export const ESTIMATED_CHARS_PER_TOKEN = 3.5;

/** Added per message, for the role marker and the per-message framing every
 *  chat API wraps around content. Small and deliberately flat -- its job is
 *  to stop a long run of very short messages ("ok", "why?", the highest-
 *  frequency replies in a Socratic tutor) from being estimated at near-zero
 *  when each one really costs a handful of tokens. */
export const PER_MESSAGE_TOKEN_OVERHEAD = 4;

/** Held back from the history budget for everything in the request that is
 *  neither the system prompt nor the message history: the JSON schemas of
 *  this turn's tool catalog (chat.ts's TOOLS -- four tools' names,
 *  descriptions and input schemas are real input tokens the model is
 *  charged for), plus provider-side framing. Flat rather than computed from
 *  the live catalog: the catalog is small and bounded, and a fixed reserve
 *  keeps this function pure and independent of the `ai` package's own tool
 *  serialization, which this module deliberately does not import. */
export const TOOL_AND_FRAMING_RESERVE_TOKENS = 1_024;

/** Per-model context windows, in tokens.
 *
 *  Same philosophy as lib/llm-config.ts's MODEL_PRICING_PER_MILLION_TOKENS
 *  (and deliberately kept out of that module, which is about resolution and
 *  credentials): list only figures there is a real source for, and do not
 *  invent one. `gpt-5.3-codex` -- the platform default model (#340,
 *  llm-config.ts's PLATFORM_DEFAULT_MODEL_NAME), routed through UW SSEC's
 *  LLMOxie/LiteLLM gateway -- is deliberately ABSENT for exactly the reason
 *  that module's pricing table gives for omitting it: what that gateway
 *  actually admits per request is institution-specific configuration this
 *  codebase has no source of truth for. It takes the default below.
 *
 *  The one entry present is the pre-#340 OpenRouter default, whose 262K
 *  window is stated in #88's own text.
 *
 *  Exact match on `llm_configs.model_name`, not a prefix rule: provider-
 *  qualified ids ("google/gemma-4-31b-it:free") and bare ones
 *  ("gpt-5.3-codex") coexist in this column, and a prefix rule over that
 *  mixture is how a 8K model quietly inherits a 262K sibling's entry. */
export const MODEL_CONTEXT_WINDOW_TOKENS: Readonly<Record<string, number>> = {
  "google/gemma-4-31b-it:free": 262_144,
};

/** The window assumed for a model not in the table above.
 *
 *  This is the one number here that is a JUDGEMENT rather than a source, so
 *  the reasoning is stated: 128K is the window shared by the great majority
 *  of the models the two supported providers front today. Guessing LOW is
 *  graceful (a little more history is dropped than had to be, on long
 *  conversations only); guessing HIGH is a hard provider error on a
 *  student's turn. That asymmetry is why this is not, say, 1M.
 *
 *  It is also why the FIX for a deployment that routes to a genuinely small
 *  model (an 8K or 16K local model, `provider: "local"`) is to add that model
 *  to the table above -- not to lower this default, which would penalise
 *  every conversation on every other model to protect one. */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;

/** The floor on the history budget: however tight the arithmetic gets, this
 *  many tokens' worth of trailing conversation is always offered.
 *
 *  Reached only by a pathological config -- one whose `max_completion_tokens`
 *  is set near or above its model's whole window, which is a misconfiguration
 *  rather than a state to serve faithfully. The alternative (a zero or
 *  negative budget) would send the model the student's question with NO
 *  conversational context at all and no signal that anything was wrong: the
 *  tutor would appear to have amnesia every single turn. Dropping some
 *  history is graceful degradation; dropping all of it is a broken tutor. */
export const MIN_HISTORY_BUDGET_TOKENS = 1_000;

/** The minimum shape this module needs off a message. Structurally
 *  compatible with the AI SDK's `UIMessage` (chat.ts passes those directly)
 *  and with the raw persisted row shape, WITHOUT importing `ai` -- same
 *  convention lib/prompts.ts follows for the same reason (that module takes
 *  `string[]` rather than the SDK's `ToolSet`), so this stays pure text/JSON
 *  arithmetic that a test can exercise with plain object literals. */
export interface BudgetableMessage {
  role: string;
  parts: unknown;
}

/** Conservative token estimate for a string. See ESTIMATED_CHARS_PER_TOKEN
 *  for why the divisor overcounts on purpose. */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / ESTIMATED_CHARS_PER_TOKEN);
}

/** Conservative token estimate for one message, INCLUDING its non-text
 *  parts.
 *
 *  #88 requirement 3 ("code/`code_execution` messages get sensible
 *  treatment", recent runs verbatim being the accepted v1): this is the line
 *  that actually delivers it. An `executeRCode` or `showDefinition` part is
 *  serialized JSON on the wire, and it is frequently the LARGEST thing in a
 *  message -- a text-only estimator would have scored a message carrying a
 *  200-line R script as near-free and kept 40 of them. Serializing the whole
 *  `parts` array counts tool payloads at their real weight, and the JSON
 *  punctuation it also counts is additional deliberate conservatism.
 *
 *  Recent runs are then kept VERBATIM (this module never rewrites a message,
 *  only decides whether it fits) and older ones drop off the front like any
 *  other turn. Summarising an old run down to an outcome line is the issue's
 *  own explicit nice-to-have, and belongs with the rolling-summary work this
 *  pass excludes.
 *
 *  A `parts` value that cannot be serialized at all (a cycle -- not
 *  reachable from a jsonb column or a validated request body, but this is a
 *  `unknown` field) is charged the whole per-message budget rather than
 *  zero: an unmeasurable message must not be treated as a free one. */
export function estimateMessageTokens(message: BudgetableMessage): number {
  let serialized: string;
  try {
    serialized = JSON.stringify(message.parts) ?? "";
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
  return estimateTextTokens(serialized) + PER_MESSAGE_TOKEN_OVERHEAD;
}

/** The context window for a model id -- the table above, else the documented
 *  default. Per-model by construction: the caller passes the model name off
 *  the config it ALREADY resolved for this turn, so this can never be the
 *  hardcoded constant #88 objects to. */
export function contextWindowTokensFor(modelName: string): number {
  return MODEL_CONTEXT_WINDOW_TOKENS[modelName] ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
}

export interface HistoryBudgetInput {
  /** Every model that could serve THIS turn -- the resolved primary, plus
   *  the failover hop when one is configured (#364/#98). The smallest window
   *  among them wins; see resolveHistoryTokenBudget's own doc comment. */
  modelNames: readonly string[];
  /** The reservation for the model's own answer: `llm_configs.
   *  max_completion_tokens`, which chat.ts also passes to streamText as
   *  `maxOutputTokens`. #88 requirement 1 states the budget in exactly these
   *  terms ("...must fit the configured model's window with headroom for the
   *  response (`max_completion_tokens`)"). Carried from the PRIMARY on both
   *  hops, matching what chat.ts's buildTurnParams actually sends (#364). */
  maxCompletionTokens: number;
  /** The fully assembled system prompt (lib/prompts.ts's
   *  assembleSystemPrompt output) -- template + section content + guardrails
   *  + tool paragraph + voice constraints. Charged against the window BEFORE
   *  any history is, which is the mechanical reason the system prompt can
   *  never be the thing that gets dropped. */
  systemPrompt: string;
}

/** How many tokens of message history the window has room for, once the
 *  response headroom, the system prompt, and the tool/framing reserve are
 *  taken out of it.
 *
 *  THE SMALLEST WINDOW AMONG THE HOPS, not the primary's: chat.ts builds ONE
 *  message array and hands it to both hops (buildTurnParams' own invariant --
 *  a failover may differ from the primary only in which provider client and
 *  which model id, never in what was asked). A budget computed from the
 *  primary alone would therefore be the wrong budget for the exact request
 *  the fallback serves -- and a failover firing at all means the primary is
 *  already down, so overflowing the backup would turn a recoverable outage
 *  into a failed turn.
 *
 *  Floors at MIN_HISTORY_BUDGET_TOKENS -- see that constant for why a
 *  zero/negative result is not passed through. */
export function resolveHistoryTokenBudget(input: HistoryBudgetInput): number {
  const window = Math.min(...input.modelNames.map(contextWindowTokensFor));
  const budget =
    window - input.maxCompletionTokens - estimateTextTokens(input.systemPrompt) - TOOL_AND_FRAMING_RESERVE_TOKENS;
  return Math.max(budget, MIN_HISTORY_BUDGET_TOKENS);
}

export interface WindowedHistory<T> {
  /** The trailing run of `messages` that fits, in the same chronological
   *  order it came in. Never empty when `messages` was non-empty. */
  messages: T[];
  /** How many messages were dropped off the FRONT. Zero on the overwhelming
   *  majority of turns (the whole trailing MAX_HISTORY_MESSAGES window fits
   *  comfortably in a modern context). chat.ts logs a non-zero value rather
   *  than dropping silently -- the whole complaint #288 makes about the
   *  count-based window is that a silent drop is indistinguishable from the
   *  tutor being obtuse, and an operator debugging "the tutor forgot" needs
   *  to be able to see that this fired. */
  droppedCount: number;
  /** True when the single most recent message ALONE exceeds the budget and
   *  was kept anyway. #88's own edge case ("If one message exceeds the
   *  limit, must still include it (cannot drop the query). Log a warning").
   *  chat.ts warns on it. */
  lastMessageExceedsBudget: boolean;
}

/** Drops whole messages off the FRONT of a chronological array until the
 *  rest fits `budgetTokens`.
 *
 *  Invariants, each of which has a test of its own:
 *
 *   1. THE SYSTEM PROMPT ALWAYS SURVIVES -- structurally, not by a rule
 *      here: the system prompt is not a member of this array at all. It is
 *      charged against the window inside resolveHistoryTokenBudget above,
 *      before this function is ever handed a number, so there is no code
 *      path on which this can drop it. chat.ts passes it to streamText's own
 *      `system` option, separate from `messages`.
 *   2. THE CURRENT QUESTION ALWAYS SURVIVES. The last element is kept
 *      unconditionally, even when it alone blows the budget -- dropping the
 *      turn the student just sent would leave the model answering nothing.
 *      Flagged via `lastMessageExceedsBudget` rather than silently.
 *   3. WHOLE MESSAGES ONLY. Nothing is truncated mid-message and no message
 *      is rewritten, so a message carrying a tool call keeps its own result
 *      parts (in the AI SDK's UIMessage shape a tool call and its output
 *      live in the SAME message's `parts`), and a kept message is byte-
 *      identical to the persisted row. This is what keeps the model from
 *      seeing a half-executed tool sequence.
 *   4. NOTHING IS ADDED. The output is always a contiguous SUFFIX of the
 *      input -- no summary, no placeholder, no synthesized "[earlier
 *      messages omitted]" note. A message the model sees is therefore always
 *      a message the server itself persisted (chat.ts's #143 trust
 *      boundary), and no new text-bearing surface is introduced through
 *      which a section solution could reach the prompt.
 *
 *  Boundary rule: a message is kept when the running total INCLUDING it is
 *  at most the budget. Exactly-at-budget fits. */
export function windowMessagesToTokenBudget<T extends BudgetableMessage>(
  messages: readonly T[],
  budgetTokens: number,
): WindowedHistory<T> {
  if (messages.length === 0) {
    return { messages: [], droppedCount: 0, lastMessageExceedsBudget: false };
  }

  const lastCost = estimateMessageTokens(messages[messages.length - 1]!);
  // Invariant 2: the current question is kept before the budget is consulted
  // for anything else, so `total` can legitimately start out over budget.
  let total = lastCost;
  let firstKept = messages.length - 1;

  for (let i = messages.length - 2; i >= 0; i--) {
    const cost = estimateMessageTokens(messages[i]!);
    if (total + cost > budgetTokens) break;
    total += cost;
    firstKept = i;
  }

  return {
    messages: messages.slice(firstKept),
    droppedCount: firstKept,
    lastMessageExceedsBudget: lastCost > budgetTokens,
  };
}
