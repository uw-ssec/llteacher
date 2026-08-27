/* --------------------------------------------------------------------------
   POST /api/chat — Vercel AI SDK chat endpoint.

   #317 review, #353: this header previously said "receives the client's
   UIMessage history" and "calls OpenRouter" -- both stopped being true
   earlier in the same PR and were never updated here, the same defect
   class the prior review already caught four lines below (#26's own doc
   comment). The client (prepareSendMessagesRequest, client/App.tsx) sends
   only its LAST message per turn -- everything before that is rebuilt
   server-side from persistedHistory (see the Persistence section below).
   And the provider/model are resolved per-conversation (#26,
   lib/llm-config.ts) to whichever of openrouter or llmoxie the resolved
   llm_configs row names -- llmoxie is every org's intended default as of
   migration 0035, not openrouter.

   Converts the resolved history to model messages, calls streamText with
   this route's tool catalog (TOOLS, below), and streams the response back
   in the UI message stream format that the client's useChat hook
   understands.

   The model can produce plain markdown text, and/or call any of:
     · showDefinition      — a display tool; renders a <DefinitionCard />
     · executeRCode        — a display tool; renders a runnable R snippet
                              the student executes client-side via WebR (#28)
     · requestHint         — a side-effecting tool; records a hint request
                              via the same ledger the "Give me a hint" button
                              uses (#80), for a student who asks in plain
                              conversation instead
     · markSectionComplete — a display tool; suggests (never auto-submits)
                              that the student may be ready to move on (#168)
   See TOOLS' own doc comment (below) for each tool's exact shape and the
   reasoning behind it, and toolsForConversation for which of these a given
   turn is actually offered.

   Persistence (#3): every turn writes to the DB so a conversation survives a
   reload --
     1. resolve/create the conversation (conversationId from the client, or
        a brand-new conversation if absent -- kind/sectionId decide which
        surface it belongs to, see ChatRequestBody, #214)
     2. check the two retry/idempotency cases (see hasRenderableContent and
        the getLastMessages call below) -- either short-circuits without
        touching the model, or persists the inbound user message before
        calling it
     3. stream the response, persisting the full final UIMessage (text + any
        tool parts) via toUIMessageStreamResponse's onFinish hook
     4. return the conversationId to the client via the x-conversation-id
        response header, so it can send it back on the next turn

   Resilience & concurrency (#96): the contract every failure mode here is
   held to, and the two non-goals that are deliberate rather than missing.
     · Duplicate sends are deduped on the client-minted `clientMessageId`
       (never on content -- see classifyTurn and #213), so a double-fired
       send, a fetch-layer retry, or a duplicated tab resolves to the SAME
       turn: the completed reply is replayed if the winner already finished,
       and the loser is told to wait (409 `in_progress`) if it hasn't. The
       per-conversation turn lock is what makes that the common path rather
       than the race path.
     · An interrupted turn persists NOTHING for the assistant half (#268's
       onFinish gate), so the transcript after a drop is the student's
       question with no reply -- never a truncated answer, and never a
       "partial, flagged interrupted" row. Recovery is a plain re-ask or the
       client's regenerate (same clientMessageId, so it dedupes here rather
       than double-writing the question). NON-GOAL: there is no stream
       checkpoint, no resume endpoint, and no partial-content store. #30's
       streaming invariant ("verify either message is completely saved or
       partially saved messages don't appear in transcript") is upheld by
       refusing the write, not by recording and replaying progress.
     · Two tabs on one conversation is last-writer-wins, with the persisted
       transcript as truth on reload. NON-GOAL for v1: no realtime sync, no
       cross-tab channel, no merge. The lock already prevents the only
       corrupting outcome (two interleaved turns writing into one
       conversation); a second tab otherwise just holds a stale view until it
       reloads.

   System prompt: resolved per-conversation (#25, lib/prompts.ts) from the
   conversation's pinned prompt_templates row + section context, never
   hardcoded. Model/provider/params are resolved per-conversation too (#26,
   lib/llm-config.ts) from the org/course/homework's llm_configs row, never
   hardcoded -- see resolveLLMConfig's own call site below.
   -------------------------------------------------------------------------- */

import type { Context } from "hono";
import {
  streamText,
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  jsonSchema,
  stepCountIs,
  type UIMessage,
  type UIMessageStreamWriter,
  type ToolSet,
  type ToolCallOptions,
} from "ai";
import { z } from "zod";
import { makeDb } from "../../db/client";
import type { Db } from "../../db/client";
import type { ConversationKind } from "../../db/schema";
import {
  createConversation,
  appendMessage,
  getLastMessages,
  getOwnedConversationOrNull,
  acquireConversationTurnLock,
  releaseConversationTurnLock,
  finalizeAssistantTurn,
  pinConversationPromptTemplate,
} from "../repositories/conversations";
import { reserveRateLimitSlot, RATE_LIMIT_MAX_PER_MINUTE, RATE_LIMIT_WINDOW_MS } from "../repositories/rateLimits";
import {
  startSectionConversation,
  getActiveSectionConversation,
  isStudentInCourse,
  SectionConversationExistsError,
  SectionNotFoundError,
  SectionNotInteractiveError,
} from "../repositories/sectionConversations";
import { courseScopeFromAuthContext, unsafeCourseScope, unsafeOrgScope, type OrgScope } from "../repositories/scope";
import { IdempotencyKeyConflictError } from "../repositories/errors";
import { recordHintRequest } from "../repositories/hints";
import { getOrgScopeAndLlmConfigForCourse } from "../repositories/organizations";
import { logServerError, logServerWarn } from "../utils/errors";
import {
  assembleSystemPrompt,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_MARK_COMPLETE_INSTRUCTION,
  HINT_INSTRUCTION,
  getPinnedPromptTemplateContent,
  getSectionPromptContext,
  resolvePromptTemplate,
} from "../../lib/prompts";
import {
  resolveLLMConfig,
  resolveApiKey,
  buildProviderClient,
  estimateCostCents,
  LLMConfigNotFoundError,
  LLMCredentialMissingError,
  UnsupportedLLMProviderError,
} from "../../lib/llm-config";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";

/* Tool catalog typed as ToolSet. We use the AI SDK's jsonSchema() helper
   instead of Zod here — Zod's deeply parameterized types collide with the
   ToolSet generic inference (TS2589).

   Display tools (like showDefinition) render args on the client via the
   registry in @llteacher/ui/generative. They still ship a server-side
   `execute` that returns a sentinel: without a tool result the conversation
   history becomes invalid the moment the user sends a second message (the
   model sees an assistant message with an unanswered tool call and either
   refuses or emits nothing). The sentinel also lets the model continue with
   follow-up text in the same turn via stopWhen below. */
export const TOOLS: ToolSet = {
  showDefinition: {
    description:
      "Render a formal definition card for a named statistical concept. " +
      "Use when introducing a term by name (e.g., 'p-value', 'standard error'). " +
      "Keep body to 1-2 sentences in plain language. " +
      "Args: term (the concept name); body (the plain-language definition).",
    inputSchema: jsonSchema<{ term: string; body: string }>({
      type: "object",
      properties: {
        term: {
          type: "string",
          description: "The term being defined, e.g. 'p-value'",
        },
        body: {
          type: "string",
          description: "Plain-language definition in 1-2 sentences",
        },
      },
      required: ["term", "body"],
      additionalProperties: false,
    }),
    execute: async ({ term }: { term: string; body: string }) => ({
      status: "displayed" as const,
      term,
    }),
  },
  /* #28: R execution is entirely client-side (WebR/WASM in the browser --
     see apps/web/src/client/hooks/useWebR.ts, useRExecution.ts) -- this
     Worker never runs R itself (the issue's own non-goal: "no server-side
     code execution"). executeRCode is a DISPLAY tool exactly like
     showDefinition above: the model supplies `code` (and optionally
     `showSource`) as its input, this execute() returns a sentinel that
     satisfies the tool-call contract (a tool call with no result poisons
     the next turn's history, see this catalog's own doc comment) without
     claiming the code actually ran here, and the CLIENT (packages/ui's
     CodeExecution renderer, dispatched by render.tsx's tool-executeRCode
     case) is what lets the student actually run it via the shared WebR
     singleton and renders the real result. `status: "displayed"` (not
     "executed") is deliberate -- an "executed" sentinel from THIS
     execute() would misstate that the server ran the code, when nothing
     has run yet. */
  executeRCode: {
    description:
      "Show the student a runnable R code snippet they can execute themselves in the browser. " +
      "Use when demonstrating a technique or inviting hands-on practice with the student's own data. " +
      "Args: code (the R source to show); showSource (whether to display the code itself " +
      "alongside any result once run -- default true).",
    inputSchema: jsonSchema<{ code: string; showSource?: boolean }>({
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "R source code, e.g. 'mean(c(1, 2, 3))'",
        },
        showSource: {
          type: "boolean",
          description: "Whether to display the code itself alongside any result. Defaults to true.",
        },
      },
      required: ["code"],
      additionalProperties: false,
    }),
    execute: async ({ code }: { code: string; showSource?: boolean }) => ({
      status: "displayed" as const,
      code,
    }),
  },
  /* #80: unlike showDefinition/executeRCode above -- pure, side-effect-free
     display tools whose execute() only ever returns a sentinel -- requestHint
     has a genuine server-side side effect: recording a hintEvents row and
     checking the section's hint budget (recordHintRequest,
     repositories/hints.ts). That's the deviation from the display-tool shape
     this catalog otherwise follows, and it needs request-scoped context (db,
     org scope, conversationId/sectionId/studentId/promptTemplateId) that a
     static, module-level ToolSet has no way to close over. Threaded in via
     streamText's own `experimental_context` option (see chatHandler's
     streamText call below) -- the AI SDK's designed mechanism for exactly
     this -- rather than rebuilding TOOLS from scratch on every request.

     This is deliberately NOT the primary hint-request path. That's
     chatHandler's own `isHintRequest` envelope flag (ChatRequestBody's own
     doc comment): checked and deterministically granted/denied server-side
     BEFORE the model is ever called, which is what "Give me a hint"
     (Composer.tsx) actually triggers. The reason the envelope flag is
     primary is NOT that a tool call can't shape the model's own output --
     it genuinely can, via prepareStep below (ai@5.0.195's PrepareStepResult
     supports a per-step `system` override, confirmed in
     @ai-sdk/provider-utils' own type -- see prepareStep's doc comment for
     how this tool actually uses that). The reason is issue #80's own
     explicit preference (requirement 1): "an explicit student action...
     is the recommended model -- deterministic and countable -- vs.
     heuristic classification of tutor replies (fragile; avoid)." A tool
     call is still the MODEL deciding whether/when to invoke it -- even
     with prepareStep available to react to that decision, the decision
     itself remains non-deterministic in exactly the way the issue asks to
     avoid, unlike a server-side gate that runs unconditionally on every
     hint-flagged request regardless of what the model would have chosen.

     This tool exists as a secondary, best-effort path for a student who
     types something like "can I get a hint?" in plain conversation instead
     of clicking the button -- it calls the exact SAME recordHintRequest
     function the envelope path uses, so both paths write to one canonical
     event ledger with identical budget/idempotency semantics; neither can
     grant a hint the other wouldn't also count. prepareStep (below) is what
     makes this path's scaffolding actually reliable rather than merely
     hoped-for from this tool's own description text: when this tool grants
     a hint in one step, prepareStep injects the same HINT_INSTRUCTION the
     envelope path uses into the system prompt for the model's NEXT step,
     within the same streamText call. */
  requestHint: {
    description:
      "Request a scaffolded hint for the student's CURRENT homework section, when they explicitly ask " +
      "for one in conversation (e.g. 'can I get a hint?', 'give me a hint'). Checks the section's hint " +
      "budget and records the request. Takes no arguments -- always call it with an empty object. " +
      "If the result's status is \"hint_provided\": respond with a scaffolded nudge -- ask a leading " +
      "question or highlight a key concept -- never the full solution. " +
      "If \"budget_exceeded\": tell the student they've used all the hints available for this section, " +
      "and do not answer the underlying question for them instead.",
    inputSchema: jsonSchema<Record<string, never>>({
      type: "object",
      properties: {},
      additionalProperties: false,
    }),
    execute: async (_input: Record<string, never>, options: ToolCallOptions) => {
      // Structurally withheld from a tutor-kind conversation's tool list
      // (SECTION_ONLY_TOOL_NAMES / toolsForConversation, below) since the
      // PR3 final-review cleanup -- ctx.sectionId is therefore guaranteed
      // non-null whenever the model can actually reach this execute(). The
      // `HintToolContext` type still carries `sectionId: string | null`
      // because it's shared with a tutor-kind request's experimental_context
      // (never read there, since the tool isn't offered), not because this
      // branch needs to handle null here anymore.
      const ctx = options.experimental_context as HintToolContext;
      const result = await recordHintRequest(ctx.db, ctx.orgScope, {
        conversationId: ctx.conversationId,
        sectionId: ctx.sectionId as string,
        studentId: ctx.studentId,
        promptTemplateId: ctx.promptTemplateId,
      });
      return { status: result.status, remainingHints: result.remainingHints };
    },
  },
  /* #168: the tutor stopping rule -- a zero-argument tool the model calls
     once it judges the student has demonstrated understanding of the
     CURRENT section. The issue's own explicit design guidance (Implementation
     Notes): no confidence/reasoning parameter -- the model signals only
     THAT the section is complete, never a rubric or score, which keeps the
     judgement cheap and avoids inventing assessment data this app has
     nowhere real to put. Deliberately NOT gated behind a jsonSchema like
     requestHint's Record<string, never> input either -- same shape,
     matching that precedent exactly.

     Unlike showDefinition/executeRCode/requestHint above, this tool's own
     description text does NOT carry the pedagogy for WHEN to call it
     ("unblock early, don't be pedantic," the issue's own Context section
     paraphrasing the reference implementation) -- that wording is tunable
     per LLM config (the issue's own explicit requirement) and lives
     instead in the system prompt, assembled by lib/prompts.ts's
     assembleSystemPrompt from resolvedLLMConfig.markCompleteInstruction
     (falling back to DEFAULT_MARK_COMPLETE_INSTRUCTION) -- see
     chatHandler's own systemPrompt assembly below. A description baked
     into this static, module-level TOOLS catalog could never vary per
     config the way a per-request system-prompt string can.

     A pure display tool, same shape as showDefinition/executeRCode (see
     this catalog's own doc comment) -- execute() has no side effect and
     no DB write of its own. It does NOT submit the section (that stays
     the student's own explicit action via the existing Submit button,
     #22) and does NOT lock or end the conversation (issue requirements:
     "surfaced... as a suggestion, not an automatic irreversible submit";
     "students can keep working after the tool fires"). The client renders
     a suggestion card (packages/ui's SectionCompleteSuggestion, dispatched
     by render.tsx's tool-markSectionComplete case) that nudges the student
     toward the existing Submit action without ever triggering it itself.

     "Invocation is persisted against the conversation, with the message
     that triggered it" (issue requirement) falls out of the SAME
     message-persistence path every other tool call in this catalog
     already goes through (onFinish -> finalizeAssistantTurn, replayed via
     replayPersistedPart) -- no bespoke persistence mechanism needed: the
     assistant message carrying this tool call is written to `messages`
     like any other, in sequence right after the user message that
     prompted it, so a later evaluation harness (#89, out of scope here)
     can already query for it by scanning messages.parts for
     tool-markSectionComplete.

     Tenancy/rate-limiting (#143, issue's own "Interaction with #143"
     note): this execute() runs inside the same streamText call, inside
     the same already-authenticated (authMiddleware), tenancy-bound
     (courseScopeFromAuthContext / getOwnedConversationOrNull), rate-limited
     (reserveRateLimitSlot, checked before this handler ever reaches
     streamText) request handler every other tool in this catalog runs
     inside -- there is no separate/unauthenticated code path for it to
     need hardening of its own. */
  markSectionComplete: {
    description:
      "Mark this homework section as complete once you judge the student has demonstrated understanding. " +
      "Takes no arguments -- always call it with an empty object. Calling it only surfaces a suggestion to " +
      "the student that they may be ready to move on; it does not submit anything on their behalf and does " +
      "not end the conversation, so the student can keep asking questions afterward.",
    inputSchema: jsonSchema<Record<string, never>>({
      type: "object",
      properties: {},
      additionalProperties: false,
    }),
    execute: async (_input: Record<string, never>) => ({ status: "suggested" as const }),
  },
};

/** #168, folded together with #80 in the PR3 final-review cleanup: tool
 *  names that must be withheld from a tutor-kind conversation -- there is no
 *  section for either of these to act on without one. Both markSectionComplete
 *  and requestHint are real, structural gating here: the model is never even
 *  offered either tool on a tutor-kind conversation, so "don't call this"
 *  isn't a hoped-for prompt instruction the model could ignore.
 *
 *  requestHint originally shipped (#80) with a weaker mechanism instead --
 *  staying in every conversation's tool list and self-reporting
 *  `{ status: "unavailable" }` from inside its own execute() when there was
 *  no sectionId. The PR3 final review flagged the resulting three-way
 *  inconsistency (this structural gate vs. that self-report vs.
 *  executeRCode/showDefinition's "never gated, and correctly so -- both are
 *  meaningful on either conversation kind") as worth a human decision rather
 *  than auto-fixing it. The decision: fold requestHint in here too, since
 *  toolsForConversation already existed and already gates on the identical
 *  sectionId signal -- there was no real reason left for a second, weaker
 *  mechanism to keep gating the same thing. */
const SECTION_ONLY_TOOL_NAMES = new Set<keyof typeof TOOLS>(["markSectionComplete", "requestHint"]);

/** #168: the actual conditional that makes section-kind-only gating real
 *  rather than cosmetic -- builds a DIFFERENT `tools` object/subset per
 *  request, passed to streamText's own `tools` option (chatHandler, below),
 *  instead of always passing the full static TOOLS catalog the way every
 *  tool before this one did. `sectionId` is `conv.sectionId` as-is: null
 *  for a tutor-kind conversation, non-null for a section-kind one -- the
 *  same signal HintToolContext.sectionId already uses, and the same
 *  invariant the DB enforces structurally (conversations_kind_section_chk,
 *  db/schema/runtime.ts: kind='section' <=> section_id IS NOT NULL), so
 *  this doesn't need conv.kind itself (resolveConversation's own return
 *  type doesn't carry it) to gate correctly. Exported so this exact
 *  conditional -- not just TOOLS.markSectionComplete's own shape -- is
 *  unit-testable without going through the full HTTP handler.
 *
 *  Final-review fix wave, #80 finding (hint double-grant): `options.
 *  withholdRequestHint` is the second, independent axis this function now
 *  gates on -- passed `true` by chatHandler exactly when isHintGranted is
 *  true for THIS turn (the envelope's isHintRequest flag already granted a
 *  hint via recordHintRequest before streamText is ever called). Without
 *  this, requestHint stayed in the model's tool list on a hint-granted turn
 *  even though a grant already happened: the tool's own description ("call
 *  this when they explicitly ask... in conversation") plus this turn's
 *  hint-primed system prompt and its fixed user message (App.tsx's
 *  HINT_REQUEST_MESSAGE, "Give me a hint for this section, please.")
 *  maximally prime the model to call it too, recording a SECOND hintEvents
 *  row for one button click -- corrupting the exact metric #80 exists to
 *  define. The only other dedup (recordHintRequest's 2-second idempotency
 *  window, repositories/hints.ts) can't be relied on here: a tool call from
 *  the model necessarily happens AFTER the envelope grant's own provider
 *  round-trip, which routinely exceeds 2 seconds. Deliberately reusing this
 *  same function (rather than a second, separate gating mechanism at the
 *  streamText call site) so there remains exactly one place that decides
 *  which tools a turn is offered -- not two. Omitting `options` (or passing
 *  `withholdRequestHint: false`) leaves requestHint's normal availability
 *  untouched, matching every call site from before this fix. */
export function toolsForConversation(
  sectionId: string | null,
  options?: { withholdRequestHint?: boolean },
): ToolSet {
  const withheldNames = new Set<keyof typeof TOOLS>();
  if (!sectionId) {
    for (const name of SECTION_ONLY_TOOL_NAMES) withheldNames.add(name);
  }
  if (options?.withholdRequestHint) {
    withheldNames.add("requestHint");
  }
  if (withheldNames.size === 0) return TOOLS;
  return Object.fromEntries(
    Object.entries(TOOLS).filter(([name]) => !withheldNames.has(name as keyof typeof TOOLS)),
  );
}

/** #80: the shape threaded into streamText's `experimental_context` option
 *  (chatHandler, below) for the requestHint tool's execute() to read via
 *  its second argument -- see requestHint's own doc comment for why this
 *  can't just be a closure over module-level TOOLS. `sectionId` is still
 *  typed `string | null` here because this context is built for every
 *  request regardless of conversation kind (populated with `conv.sectionId`
 *  as-is), even though requestHint itself is only ever offered, and so only
 *  ever reads this, when it's non-null (SECTION_ONLY_TOOL_NAMES). */
interface HintToolContext {
  db: Db;
  orgScope: OrgScope;
  conversationId: string;
  sectionId: string | null;
  studentId: string;
  promptTemplateId: string | null;
}

interface ChatRequestBody {
  messages: UIMessage[];
  // Absent on the first turn of a new conversation -- chatHandler creates
  // one. Present on every subsequent turn (the client stores whatever came
  // back in the previous response's x-conversation-id header).
  conversationId?: string;
  // Absent today: the client (App.tsx) has no real course selection yet --
  // that's a later task in this epic (conversation lifecycle, #27). Kept
  // optional and honored when present so a future client doesn't need
  // another server-side change to start passing it. Until then, new tutor
  // conversations fall back to the caller's own (first) course membership --
  // same "single course/org per user" assumption submissionsHandler already
  // makes elsewhere in this file's sibling routes.
  courseId?: string;
  // #214: which surface a brand-new conversation belongs to. Defaults to
  // "tutor" when omitted, preserving every existing caller's behavior --
  // the free-standing tutor rail (#4) never sends this. The homework-section
  // chat instance (App.tsx) sends "section" + its real sectionId, so its
  // auto-created conversation is properly scoped and never shows up in the
  // tutor rail's kind=tutor listing.
  kind?: ConversationKind;
  // Required when kind is "section"; ignored otherwise. Validated against
  // scope by createConversation's own tenancy check (repositories/
  // conversations.ts), which throws TenancyMismatchError -> 404 on a
  // mismatch, the same mapping every other tenancy check in this app uses.
  sectionId?: string;
  // #80: set by the "Give me a hint" trigger (Composer.tsx) -- a REQUEST to
  // treat this turn as a hint, not a claim that it IS one. chatHandler
  // independently, deterministically decides that via recordHintRequest
  // (repositories/hints.ts) before the model is ever called; a client that
  // sets this to true gets budget-checked and either granted (a real event
  // is recorded and the prompt is scaffolded) or denied (no event, no model
  // call) -- the flag itself grants nothing. Ignored (silently, not an
  // error) for a tutor-kind conversation or one with no sectionId: hints
  // are a section concept only.
  isHintRequest?: boolean;
}

// Validates only the shape chatHandler actually depends on (id, role, and
// parts being a non-empty array of `{ type, ... }` objects) -- not the full
// AI SDK UIMessage schema. A buggy or malicious client sending a malformed
// parts array must 400 here rather than reach appendMessage's jsonb insert,
// which would happily store whatever it's given (#3 pitfall 4). `id` is
// required as of #213: it's the AI SDK's own per-send UIMessage id, used as
// the idempotency key below instead of comparing message content.
//
// #266 asked for `z.string().uuid()` here, on the claim that it "matches
// what the AI SDK actually generates." Checked against the pinned
// ai@5.0.195 rather than assumed: @ai-sdk/provider-utils's actual default
// `generateId` (`createIdGenerator()`, no options) produces a 16-character
// string from an alphanumeric alphabet with NO separator by default --
// there is no `-`, so it is not UUID-shaped, and this app's own
// `useChat()` calls (App.tsx) don't override that default. `.uuid()` would
// 400 every real client request. CLIENT_MESSAGE_ID_RE is the actual
// boundary tightening this issue was after -- a bounded, non-arbitrary
// charset instead of "any non-empty string" -- sized generously around the
// SDK's real 16-char output (and a `prefix-` variant, if this app ever
// configures one) without requiring an exact format the SDK doesn't use.
const CLIENT_MESSAGE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

// #308: no size bound previously existed on a part's own `text` field --
// `chatPartSchema`/`historyPartSchema` were `.passthrough()`, so a text part
// could carry an arbitrarily long string all the way to appendMessage's
// jsonb insert. The sharpest failure mode wasn't even this field: a client's
// `id` (client_message_id) participates in a btree unique index, which caps
// a tuple at ~2704 bytes, so an oversized value there failed the INSERT with
// SQLSTATE 54000 -> a generic 503, no model call, no counted message --
// reserveRateLimitSlot's budget never even saw that request, since it 500s
// after persistence, not before. `id` itself is already bounded
// (CLIENT_MESSAGE_ID_RE above, 128 chars), so this addresses the same class
// of gap for the field that actually has no cap at all: message text.
const MAX_TEXT_PART_LENGTH = 8_000;
// #308: also no bound on how many parts a single message could carry (a
// message legitimately produced by this app's own composer/tool loop has a
// handful at most) or how many messages the whole request could carry --
// both were `.min(1)` with no `.max()`, and `messages` itself was checked
// only for `length > 0`.
//
// #317 review, #353: "the client sends its full local history every turn"
// stopped being true in this same PR -- prepareSendMessagesRequest
// (client/App.tsx) now trims the request body to the single last message
// (#3 pitfall 3's fix, see resolveConversation's own doc comment below)
// before it ever reaches this route. This cap still exists, and every
// element still gets validated (#264, below), because that trim is a
// CLIENT-side behavior this server-side check cannot trust -- a caller
// that skips the browser entirely can still POST an arbitrarily large
// array directly.
const MAX_PARTS_PER_MESSAGE = 32;
// Generous relative to MAX_HISTORY_MESSAGES (40, the trailing window
// actually forwarded to the model below) -- this bounds the REQUEST, not
// the model context, so a genuinely long-running conversation's full
// history can still round-trip through hydration/replay without hitting
// this cap while a scripted/malicious oversized payload still 400s.
const MAX_MESSAGES_PER_REQUEST = 500;

// Shared by chatPartSchema and historyPartSchema below: `.passthrough()`
// admits any extra keys unchecked (needed for the tool-* part shapes
// neither schema tries to fully model), so the text-length cap can't be
// expressed as a plain `z.object({ text: z.string().max(...) })` field --
// only a text-typed part has (or needs) that field at all. A `.refine` is
// the right tool for a cross-field, conditional constraint like this.
function withTextLengthCap<T extends z.ZodTypeAny>(schema: T) {
  return schema.refine(
    (part) => {
      const p = part as { type?: unknown; text?: unknown };
      return p.type !== "text" || (typeof p.text === "string" && p.text.length <= MAX_TEXT_PART_LENGTH);
    },
    { message: `a text part's text must be a string of at most ${MAX_TEXT_PART_LENGTH} characters` },
  );
}

const chatPartSchema = withTextLengthCap(z.object({ type: z.string() }).passthrough());
const inboundUserMessageSchema = z.object({
  id: z.string().regex(CLIENT_MESSAGE_ID_RE),
  role: z.literal("user"),
  parts: z.array(chatPartSchema).min(1).max(MAX_PARTS_PER_MESSAGE),
});

// #264: only the last element of `messages` was ever validated -- the AI SDK's
// convertToModelMessages has a real `case "system":` branch, so a client could
// splice a forged element ANYWHERE earlier in the array (role:"system", or a
// role:"assistant" turn that never happened) and it reached the model
// untouched, with no trace in the persisted transcript (only the last element
// is ever written). This validates every element the same way: role must be
// "user" or "assistant" (never "system", "tool", or anything else
// convertToModelMessages branches on), and every part's `type` must be one
// this app actually produces and renders -- text, the step-start marker, or a
// tool-<name> part -- matching exactly what hasRenderableContent/the
// tool-dispatch loop above understand. A "file" part in particular is
// rejected here rather than reaching convertToModelMessages, which would map
// it to an outbound fetch URL (downloadAssets) the model can request.
const ALLOWED_HISTORY_PART_TYPE_RE = /^(text|step-start|tool-[A-Za-z0-9_]+)$/;
const historyPartSchema = withTextLengthCap(
  z.object({ type: z.string().regex(ALLOWED_HISTORY_PART_TYPE_RE) }).passthrough(),
);
const historyMessageSchema = z.object({
  id: z.string().regex(CLIENT_MESSAGE_ID_RE),
  role: z.enum(["user", "assistant"]),
  parts: z.array(historyPartSchema).min(1).max(MAX_PARTS_PER_MESSAGE),
});

// #267: conversationId/courseId/sectionId genuinely are UUIDs (they
// reference conversations.id/courses.id/sections.id, real primary keys) --
// unlike CLIENT_MESSAGE_ID_RE above, `.uuid()` is the right check here, not
// a rejected one. `.passthrough()` isn't needed (unlike chatPartSchema/
// historyPartSchema): this schema only validates the four fields
// chatHandler itself reads off the body; `messages` is handled separately
// (see the unchecked-cast comment at its call site) since its own
// per-element validation already happens via historyMessageSchema/
// inboundUserMessageSchema below, not this envelope.
const chatEnvelopeSchema = z.object({
  conversationId: z.string().uuid().optional(),
  courseId: z.string().uuid().optional(),
  kind: z.enum(["section", "tutor"]).optional(),
  sectionId: z.string().uuid().optional(),
  // #80: see ChatRequestBody.isHintRequest's own doc comment.
  isHintRequest: z.boolean().optional(),
});

// In ai@5.0.195, a provider failure (e.g. a 429) arrives as an `error`
// chunk mid-stream, not a stream rejection -- the stream still closes
// normally, so `onFinish` below still fires. The AI SDK's own step
// machinery unconditionally pushes a `{ type: "step-start" }` marker part
// onto `responseMessage.parts` the moment the first chunk of a step
// arrives, before it even looks at what that chunk is -- so a
// `responseMessage.parts?.length` check alone is NOT enough to detect "the
// model produced nothing": an error-only turn still has
// `parts: [{ type: "step-start" }]`, length 1, not 0 (verified empirically
// via chat.errorChunk.integration.test.ts, which drives a real streamText()
// against a model that errors immediately). This checks for actual
// renderable content instead -- anything other than a bare step-start
// marker, and a text part only counts if it has non-empty text (defensive:
// a text-start/text-end pair with a zero-length delta is possible and
// shouldn't count as "answered" either). Used both to decide whether
// onFinish should persist an assistant row at all, and to decide whether an
// already-persisted row is complete enough to replay -- so neither path can
// treat "the model said nothing" as "the model answered."
//
// #307: an allowlist, not a denylist -- it accepts exactly the part shapes
// replayPersistedPart below can actually emit something for (non-empty
// text, or a tool-* call that resolved to output-available/output-error)
// and nothing else. The previous version accepted ANY unrecognized part
// shape (reasoning, file, source-url, or a tool-* part still mid-flight --
// input-available/input-streaming, no output yet), so a turn whose only
// "content" was one of those passed the gate, got persisted, and then
// replayPersistedPart silently dropped it on replay (its own doc comment:
// "anything else is dropped rather than guessed at") -- a permanently blank
// assistant bubble with no error and no recovery. Keeping this allowlist in
// lockstep with replayPersistedPart's emit-set is exactly what
// chat.test.ts's "#307 gate/replay parity" test asserts, so the two can't
// silently drift apart again.
//
// #342: requires every part to be complete, not just some part to be
// renderable. The previous version was `parts.some(isRenderable)` -- "is
// ANY part done" -- which a multi-part turn (step-start + a completed text
// part + a tool call still mid-flight, or a completed part followed by a
// text part still `state:"streaming"`) could satisfy on its completed part
// alone while an incomplete one sat right next to it. That shape is exactly
// what a client-side Stop or disconnect mid-multi-part-turn produces (the
// onFinish finishReason-allowlist fix above is the primary guard against
// persisting an aborted turn at all, but this function is the second layer
// for whatever reaches it regardless -- an existing row from before that
// fix shipped, or a future path that doesn't go through onFinish). Now:
// reject the WHOLE array the moment any part is still mid-flight, and only
// then check whether at least one part actually renders.
function hasRenderableContent(parts: unknown): boolean {
  if (!Array.isArray(parts)) return false;
  let sawRenderablePart = false;
  for (const part of parts) {
    if (!part || typeof part !== "object" || !("type" in part)) continue;
    const type = (part as { type: unknown }).type;
    if (type === "text") {
      const text = (part as { text?: unknown }).text;
      // #268: a text part mid-generation carries state:"streaming" until
      // the SDK closes it out as state:"done" -- a part that never got
      // there (a provider error or a client disconnect mid-delta) is
      // exactly the truncated-answer case this whole function exists to
      // catch. `state` is optional in the SDK's own type (older/synthetic
      // parts omit it) -- only an EXPLICIT "streaming" fails the whole
      // array, not its absence, so replayPersistedPart's own
      // always-complete text writes (which never set state) keep working.
      const state = (part as { state?: unknown }).state;
      if (state === "streaming") return false;
      if (typeof text === "string" && text.length > 0) sawRenderablePart = true;
      continue;
    }
    if (typeof type === "string" && type.startsWith("tool-")) {
      const toolCallId = (part as { toolCallId?: unknown }).toolCallId;
      const state = (part as { state?: unknown }).state;
      // #307: only a tool call that actually resolved -- output-available
      // (a real result) or output-error (a real, renderable failure) --
      // counts as content. #342: input-available/input-streaming means the
      // tool was invoked but the turn ended (aborted, provider error, or a
      // client Stop between the call and its result) before it resolved --
      // replayPersistedPart has nothing to emit for that state beyond a
      // dangling tool-input-available (the "poisoned history" scenario an
      // unanswered tool call leaves the model unable to recover from on the
      // next turn), so it now fails the WHOLE array rather than being
      // silently skipped while a completed part elsewhere still passes.
      if (typeof toolCallId !== "string" || (state !== "output-available" && state !== "output-error")) return false;
      sawRenderablePart = true;
      continue;
    }
    // step-start, reasoning, file, source-url/document, and anything else
    // this app's own TOOLS/renderer don't produce/display -- never counts
    // as renderable, and never fails the array either (these parts have no
    // "incomplete" state of their own to poison the check on).
  }
  return sawRenderablePart;
}

// Replays an already-persisted assistant message's `parts` (jsonb, so typed
// unknown at the DB boundary) as UIMessageChunk writes -- used only by the
// "already answered" retry path below, never by a fresh model turn. Handles
// plain text and any completed tool-* call/result generically (#28: this
// was "the two part shapes this app's own TOOLS catalog can actually
// produce" back when showDefinition was the only tool; the `part.type.
// startsWith("tool-")` branch below was already generic over the tool
// name even then, so adding executeRCode -- or any future tool -- needs no
// change here) -- anything else is dropped rather than guessed at, so an
// unrecognized part shape fails safe instead of throwing mid-replay.
function replayPersistedPart(part: { type: string } & Record<string, unknown>, writer: UIMessageStreamWriter) {
  if (part.type === "text" && typeof part.text === "string") {
    const id = crypto.randomUUID();
    writer.write({ type: "text-start", id });
    writer.write({ type: "text-delta", id, delta: part.text });
    writer.write({ type: "text-end", id });
    return;
  }
  if (
    part.type.startsWith("tool-") &&
    typeof part.toolCallId === "string" &&
    (part.state === "output-available" || part.state === "output-error")
  ) {
    // #307: only ever reached for a tool call that actually resolved --
    // hasRenderableContent's matching allowlist guarantees any part that
    // gets here is output-available or output-error, never a dangling
    // input-available/input-streaming call with no result to show.
    const toolName = part.type.slice("tool-".length);
    writer.write({ type: "tool-input-available", toolCallId: part.toolCallId, toolName, input: part.input });
    if (part.state === "output-error") {
      writer.write({
        type: "tool-output-error",
        toolCallId: part.toolCallId,
        errorText: typeof part.errorText === "string" ? part.errorText : "Tool execution failed",
      });
    } else {
      writer.write({ type: "tool-output-available", toolCallId: part.toolCallId, output: part.output });
    }
  }
}

// Builds the UI message stream Response for the "already answered" retry
// case (#3 requirement 6): no model call, no new DB rows -- just the
// previously-persisted assistant message replayed back through the same
// wire protocol a fresh streamText response would use, so the client's
// useChat can't tell the difference.
function replayResponse(conversationId: string, persistedParts: unknown) {
  const parts = Array.isArray(persistedParts) ? persistedParts : [];
  return createUIMessageStreamResponse({
    headers: { "x-conversation-id": conversationId },
    stream: createUIMessageStream({
      execute: ({ writer }) => {
        writer.write({ type: "start" });
        writer.write({ type: "start-step" });
        for (const part of parts) {
          if (part && typeof part === "object" && "type" in part && typeof (part as { type: unknown }).type === "string") {
            replayPersistedPart(part as { type: string } & Record<string, unknown>, writer);
          }
        }
        writer.write({ type: "finish-step" });
        writer.write({ type: "finish" });
      },
    }),
  });
}

// #231: derives an initial title for a brand-new tutor conversation from
// its first user message, instead of leaving every row titled "New
// Conversation" until the student manually renames it. Only ever called at
// creation time (the new-conversation branch below), so "only while the
// title is still the default" is automatic: this never re-touches an
// existing conversation's title on a later turn, whether or not the
// student has since renamed it. Truncates the first text part; returns
// null (falls back to "New Conversation") for a message with no text part
// (a tool-only first message isn't a shape this app's own composer can
// currently produce, but the fallback keeps this honest either way).
const AUTO_TITLE_MAX_LENGTH = 60;
function deriveTutorConversationTitle(parts: unknown): string | null {
  if (!Array.isArray(parts)) return null;
  const textPart = parts.find(
    (p): p is { type: "text"; text: string } =>
      !!p && typeof p === "object" && (p as { type?: unknown }).type === "text" && typeof (p as { text?: unknown }).text === "string",
  );
  const text = textPart?.text.trim();
  if (!text) return null;
  return text.length > AUTO_TITLE_MAX_LENGTH ? `${text.slice(0, AUTO_TITLE_MAX_LENGTH).trimEnd()}…` : text;
}

// #265: reserveRateLimitSlot (repositories/rateLimits.ts) is a single
// atomic upsert, called unconditionally as the FIRST thing this handler
// does after basic request validation -- before conversation resolution,
// before any persistence, before the model is ever reachable. The prior
// version read a count, then relied on a LATER, conditional appendMessage
// call as the actual counted side effect; that gap is exactly where the
// race (concurrent requests all reading the same pre-increment count) and
// the fail-open (a path that skips appendMessage but still calls the
// model) both lived. RATE_LIMIT_MAX_PER_MINUTE/RATE_LIMIT_WINDOW_MS now live
// in rateLimits.ts itself (#308) -- routes/conversations.ts's
// createConversationHandler shares the same budget/counter.

// #215: bounds what the model sees on every turn -- the trailing window
// pulled from the server's own persisted history (#143 redesign below), so
// per-turn token cost is bounded regardless of how long the conversation
// has run. Decision (documented per the issue's own request): a plain
// trailing window, dropped silently -- no rolling summary. A summarization
// strategy is real, separate work (tracked as #88, context-window
// management); until it lands, the oldest turns beyond this window are
// simply not seen by the model on a given turn, which is a graceful
// degradation (the student can still reference them in the visible UI
// transcript) rather than a hard failure.
const MAX_HISTORY_MESSAGES = 40;

// #143: bound on the inbound request body itself, checked before any
// parsing/db work -- distinct from MAX_HISTORY_MESSAGES above (which trims
// what the model sees once a request is already accepted) and
// MAX_MESSAGES_PER_REQUEST below (#308's array-length cap). A genuine
// multi-turn Socratic exchange is plaintext and comfortably under it; it
// exists to bound a runaway/malicious client, not to constrain normal usage.
const MAX_REQUEST_BODY_BYTES = 256 * 1024;

// #143: upstream model call timeout -- bounds how long a single turn can
// hang the connection (and the Worker's wall-clock budget) if the provider
// stalls instead of erroring. Generous for a Socratic turn (which can
// include a tool call + follow-up text, i.e. multiple provider round-trips
// within one streamText call, see stopWhen below), short enough that a
// genuinely stuck upstream doesn't tie up the request indefinitely.
const STREAM_TIMEOUT_MS = 60_000;

// #317 review, #349: @ai-sdk/openai's reasoning-model heuristic (both
// getOpenRouter and getLLMoxie, lib/ai.ts, use createOpenAI) treats any
// model id NOT prefixed gpt-3/gpt-4/chatgpt-4o/gpt-5-chat as a reasoning
// model and silently drops `temperature` (pushing a warning nothing here
// used to read) unless `reasoningEffort: "none"` is passed AND the model
// is one of the few families that support that escape hatch -- gpt-5.1
// through gpt-5.4, which the #340 default (gpt-5.3-codex) is. Without
// this, llm_configs.temperature (NOT NULL DEFAULT 0.7, always present) was
// always discarded before the request left the Worker: an instructor
// setting e.g. 0.2 for deterministic grading got no change and no visible
// error. Scoped to this exact family, matching @ai-sdk/openai's own
// `supportsNonReasoningParameters` check (dist/index.mjs) -- passing
// reasoningEffort to a model that doesn't support the escape hatch (e.g.
// a non-OpenAI model routed through the same OpenAI-compatible surface,
// like the pre-#340 free Gemma default) wouldn't restore its temperature
// and could misroute a parameter meant for OpenAI's own reasoning models.
const SUPPORTS_REASONING_EFFORT_NONE = /^gpt-5\.[1-4]/;

// #317 review, #322: how old a held turn lock (conversations.processing
// started_at) must be before a new request is allowed to treat it as
// abandoned rather than genuinely in-flight. Comfortably above
// STREAM_TIMEOUT_MS -- a legitimate turn's lock must never go stale while
// that same turn could still be legitimately running -- to leave room for
// the persistence work on either side of the streamText call itself.
const LOCK_STALE_MS = 90_000;

// #317 review, #350 (requirement 2): result.totalUsage/result.response/
// result.warnings all derive from the AI SDK's finalStep -> _steps.promise,
// resolved only in the recording stream's flush() -- which a genuinely
// cancelled stream (client reader.cancel(), #342's own scenario) never
// reaches. Measured: that await never settles at all, not just slowly, so
// onFinish itself hangs forever for a stopped turn -- no lock release, no
// llm_call_logs row, despite #321/#342's own doc comments both claiming
// every outcome gets logged. Races the Promise.all below against this
// timeout; on timeout, the turn is finalized with null usage/cost fields
// instead of never being finalized at all. Short relative to
// STREAM_TIMEOUT_MS -- this isn't waiting on the model, it's waiting on a
// promise that either resolves almost immediately (a real, completed turn)
// or never resolves at all (an abandoned one).
const USAGE_FETCH_TIMEOUT_MS = 5_000;

// #312: the idempotency decision below used to live inline, TWICE -- once
// for the initial check, once for the race-fallback re-check after a lost
// appendMessage race (#273) -- with no way to unit-test either copy without
// going through the full HTTP handler and its seven module mocks. Extracted
// as a pure function (no db, no I/O) so both call sites share exactly one
// copy and chat.test.ts can assert the decision table directly, with zero
// mocks.
export type TurnClassification = "replay" | "skip-insert" | "insert";

// #317 review, #326: the shape both getLastMessages (its narrowed
// LAST_MESSAGE_COLUMNS projection, repositories/conversations.ts) and the
// in-memory "insert" row built below actually need -- just enough for
// classifyTurn's idempotency check and the model-context mapping further
// down. appendMessage's returned row carries more columns (conversationId,
// seq, createdAt) that persistedHistory below never reads.
type MessageHistoryRow = { id: string; role: string; parts: unknown };

export function classifyTurn(
  lastMessage: { role: string; parts: unknown; clientMessageId: string | null } | undefined,
  secondLastMessage: { role: string; clientMessageId: string | null } | undefined,
  inboundClientMessageId: string,
): TurnClassification {
  const matchesInboundUser = (msg: { role: string; clientMessageId: string | null } | undefined) =>
    msg?.role === "user" && msg.clientMessageId === inboundClientMessageId;
  // "Already answered": the model already ran and its response is already
  // persisted for this exact user turn -- replay it, no model call.
  if (
    lastMessage?.role === "assistant" &&
    hasRenderableContent(lastMessage.parts) &&
    matchesInboundUser(secondLastMessage)
  ) {
    return "replay";
  }
  // "Not answered yet": the user message already landed but the assistant
  // hasn't responded (or its response hasn't been persisted) yet -- don't
  // insert it again, fall through to a normal model call.
  if (matchesInboundUser(lastMessage)) {
    return "skip-insert";
  }
  return "insert";
}

/** #312: conversation resolution, extracted from chatHandler -- this step
 *  has no coupling to streaming or the model call at all; it was folded into
 *  the same function only because it happened to run first. Returns a
 *  Response directly for every early-exit case (404/403/400/409) so this
 *  one seam, at least, is independently testable and doesn't require
 *  reading chatHandler's own body to follow -- callers must check
 *  `instanceof Response` before touching `.conv`.
 *
 *  #317 review, #353: this comment used to claim the extraction "leaves
 *  chatHandler's own body a thin 'resolve, then stream' dispatcher" --
 *  measured false the moment it was written, and more so with every #317
 *  review round since (request validation, rate limiting, prompt/config
 *  resolution, the release gate, lock acquisition, history fetch, turn
 *  classification, replay, model-context assembly, the streamText call,
 *  and its three stream callbacks all still live in chatHandler itself).
 *  `classifyTurn` (below) is the other extracted seam; the rest of that
 *  list are real candidates for the same treatment
 *  (`validateChatRequest`, `resolvePromptAndConfig`, `prepareTurn`) but
 *  aren't done -- correcting the claim rather than leaving it stated as
 *  true, per the same review's own reasoning: a doc comment asserting an
 *  architectural property the code doesn't have is worse than no comment
 *  at all. */
async function resolveConversation(
  c: Context<AppEnv>,
  db: Db,
  authContext: AuthContext,
  envelope: { conversationId?: string; courseId?: string; sectionId?: string; kind?: ConversationKind },
  inboundMessage: UIMessage,
): Promise<
  | {
      conv: {
        id: string;
        ownerUserId: string;
        courseId: string;
        sectionId: string | null;
        promptTemplateId: string | null;
      };
      // #272: set only when THIS call just created a fresh section
      // conversation (the try branch below, not the race-fallback catch) --
      // prepended to the model's context further down so the turn that
      // creates a section conversation doesn't answer with zero knowledge of
      // the section's actual question text, which the greeting is the sole
      // delivery mechanism for. Undefined on every other path (existing
      // conversationId, tutor kind, race fallback), which already has real
      // persisted history a normal turn would see.
      sectionGreetingParts: unknown[] | undefined;
      // #317 review, #349 (requirement 4): the same row's id, generated by
      // startSectionConversation itself (crypto.randomUUID(), not
      // DB-returned) -- lets chatHandler's own prepend below check whether
      // this exact row already made it into persistedHistory (the real,
      // committed-then-read case on every driver this repo runs; see that
      // prepend's own doc comment) instead of always prepending a second
      // copy on top of one that, in production, is already there.
      sectionGreetingMessageId: string | undefined;
      // #317 review, #326 (remaining requirement): set only on the
      // conversationId branch, where getConversationById's own join already
      // read it off the same row -- a second, separate getOrgScopeForCourse
      // round-trip for the exact same course would be pure waste. undefined
      // (not resolved) on the two conversation-creation branches below,
      // which don't get an org scope for free from their own queries;
      // chatHandler's Promise.all falls back to getOrgScopeAndLlmConfigForCourse
      // only when this is undefined.
      orgScope: OrgScope | undefined;
      // #317 review, #346 (requirement 1): same join, same reasoning --
      // getConversationById now also projects courses.llmConfigId, so this
      // is set (possibly to null, "no course-level override") whenever
      // orgScope is. Always undefined exactly when orgScope is.
      courseLlmConfigId: string | null | undefined;
    }
  | Response
> {
  if (envelope.conversationId) {
    // #279: THIS BRANCH MUST STAY READ-ONLY. chatHandler starts it
    // speculatively, BEFORE the rate-limit gate has resolved (the preflight
    // at chatHandler's `preflightResolution`, ~line 1306 below, gated on
    // this same `conversationId` check; its own comment carries the full
    // argument), precisely because it writes nothing -- that is the entire
    // reason overlapping it with the reservation cannot orphan anything. A
    // write added here (a `lastAccessedAt` touch, a lazy backfill, an
    // access-audit row) would silently reintroduce the bug that overlap was
    // designed around: a request that goes on to 429 would still have left
    // that write behind. If this branch ever needs to write, move the write
    // below the gate in chatHandler, or drop the preflight -- do not just
    // add it here. The other two branches below already create rows, which
    // is why they are deliberately NOT started early.
    //
    // #217/#222: getOwnedConversationOrNull collapses "doesn't exist",
    // "exists but isn't yours", and "exists, is yours, but soft-deleted"
    // into the same null -> 404, matching routes/conversations.ts's
    // PATCH/DELETE/GET-messages handlers exactly (moved to the repository
    // layer, repositories/conversations.ts, precisely so this route could
    // reuse it instead of hand-rolling its own 404-vs-401 split, which was
    // the existence oracle this rule exists to avoid).
    const existing = await getOwnedConversationOrNull(
      db,
      envelope.conversationId,
      authContext.session.userId,
      authContext.isMemberOf,
    );
    if (!existing) {
      return c.json({ error: "Conversation not found", code: "not_found" }, 404);
    }
    return {
      conv: existing,
      sectionGreetingParts: undefined,
      sectionGreetingMessageId: undefined,
      orgScope: unsafeOrgScope(existing.organizationId),
      courseLlmConfigId: existing.courseLlmConfigId,
    };
  }

  // #304: previously fell back to authContext.memberships[0]?.courseId when
  // the client omitted courseId -- listMembershipsForUser has no ORDER BY,
  // so Postgres gives no ordering guarantee and [0] was arbitrary, possibly
  // differing between two requests from the same user. A user with two
  // memberships (the norm for instructors and TAs) could get a tutor
  // conversation silently minted into the wrong course. Requiring courseId
  // explicitly loses no real caller: the section path already sends it on
  // every no-conversationId request (see handleSendMessage in App.tsx), and
  // courseScopeFromAuthContext below already rejects a course the caller
  // isn't a member of, so this doesn't relax that check either.
  if (!envelope.courseId) {
    return c.json({ error: "courseId is required when conversationId is omitted" }, 400);
  }
  const courseId = envelope.courseId;
  const scope = courseScopeFromAuthContext(authContext, courseId);
  if (!scope) {
    return c.json({ error: "Course access denied", code: "denied" }, 403);
  }
  // #214: kind defaults to "tutor" (every existing caller's behavior) --
  // only a caller that explicitly asks for "section" (App.tsx's
  // homework-section chat instance) needs a sectionId.
  //
  // #308/#267: an unrecognized kind used to silently coerce to "tutor"
  // instead of 400ing -- chatEnvelopeSchema's z.enum(["section","tutor"])
  // already rejects anything else before this is ever reached, so
  // envelope.kind is only ever "section", "tutor", or undefined here.
  const kind: ConversationKind = envelope.kind === "section" ? "section" : "tutor";
  if (kind === "section") {
    const requestedSectionId = envelope.sectionId;
    if (!requestedSectionId) {
      return c.json({ error: "sectionId is required when kind is 'section'" }, 400);
    }
    // #259: routed through the same startSectionConversation every other
    // section-conversation caller uses (#27's own routes), not
    // createConversation -- which enforced none of isTeacherTest derivation,
    // non_interactive refusal, the duplicate-active-conversation check, or
    // the Django-parity greeting as the first message.
    try {
      const created = await startSectionConversation(db, scope, {
        sectionId: requestedSectionId,
        ownerUserId: authContext.session.userId,
        // #237: derived from the caller's actual course role, same rule
        // startSectionConversationHandler uses -- a TA or observer sending
        // into a section is not a student doing the assignment, but is also
        // not who isInstructorOf's AUTHOR_ROLES tier means.
        isTeacherTest: !isStudentInCourse(authContext.memberships, courseId),
        canViewDrafts: authContext.canViewDraftsIn(courseId),
      });
      return {
        conv: {
          id: created.id,
          ownerUserId: authContext.session.userId,
          courseId,
          sectionId: requestedSectionId,
          promptTemplateId: created.promptTemplateId,
        },
        sectionGreetingParts: Array.isArray(created.greetingParts) ? created.greetingParts : undefined,
        sectionGreetingMessageId: created.greetingMessageId,
        orgScope: undefined,
        courseLlmConfigId: undefined,
      };
    } catch (err) {
      if (err instanceof SectionConversationExistsError) {
        // #238-style race: two requests for the same section's first turn
        // (a double-fired send, two tabs) both arrived with no
        // conversationId yet. The loser doesn't get an error -- it uses the
        // conversation the winner just created, same as any other retry
        // lands on the same conversation.
        const active = await getActiveSectionConversation(db, scope, requestedSectionId, authContext.session.userId);
        if (!active) throw err; // existence was just proven; a missing row here is a genuine bug, not a race
        return {
          conv: {
            id: active.id,
            ownerUserId: active.ownerUserId,
            courseId: active.courseId,
            sectionId: active.sectionId,
            promptTemplateId: active.promptTemplateId,
          },
          sectionGreetingParts: undefined,
          sectionGreetingMessageId: undefined,
          orgScope: undefined,
          courseLlmConfigId: undefined,
        };
      }
      if (err instanceof SectionNotFoundError) {
        return c.json({ error: "Section not found", code: "not_found" }, 404);
      }
      if (err instanceof SectionNotInteractiveError) {
        return c.json({ error: err.message, code: "in_progress" }, 409);
      }
      throw err;
    }
  }

  // #231: auto-title tutor conversations from their first message.
  const title = deriveTutorConversationTitle(inboundMessage.parts) || "New Conversation";
  const conv = await createConversation(db, scope, {
    ownerUserId: authContext.session.userId,
    sectionId: null,
    kind: "tutor",
    title,
  });
  return {
    conv,
    sectionGreetingParts: undefined,
    sectionGreetingMessageId: undefined,
    orgScope: undefined,
    courseLlmConfigId: undefined,
  };
}

export async function chatHandler(c: Context<AppEnv>) {
  // #26: the OPENROUTER_API_KEY-specific early check this replaced is gone
  // -- which key (if any) is needed depends on the resolved config's
  // provider, known only once conv/scope/homeworkId are, well below. A
  // missing/unusable key now surfaces as the Django-parity graceful 500
  // right before the model call, not as a blanket "OpenRouter isn't
  // configured" regardless of what the resolved config actually needs.

  // authMiddleware/rolesMiddleware already gate every /api/* route (chat.ts
  // is wired in unguarded via app.post("/api/chat", chatHandler) in
  // server/index.ts, same as hello.ts) -- re-checked here so a direct call
  // to this handler (as the unit tests below do) fails closed with a 401
  // instead of throwing on authContext.session below. Mirrors the guard
  // re-check convention used throughout homeworks.ts/submissions.ts.
  const authContext = c.get("authContext") as AuthContext | undefined;
  if (!authContext) {
    return c.json({ error: "Unauthorized", code: "unauthorized" }, 401);
  }

  // #143: read the raw body ourselves (not c.req.json()) so the size cap is
  // enforced against the actual byte count before JSON.parse ever runs --
  // c.req.json() would parse an oversize body first and only let a caller
  // discover the problem after paying that cost.
  let rawText: string;
  try {
    rawText = await c.req.text();
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }
  if (new TextEncoder().encode(rawText).length > MAX_REQUEST_BODY_BYTES) {
    // #317 review, #344: matches its sibling array-length cap
    // (MAX_MESSAGES_PER_REQUEST below), which already carries this code --
    // readErrorMessage (packages/ui) classifies both the same way.
    return c.json(
      { error: `Request body exceeds the ${MAX_REQUEST_BODY_BYTES} byte limit`, code: "history_too_long" },
      400,
    );
  }
  let rawBody: unknown;
  try {
    rawBody = JSON.parse(rawText);
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }
  // #267: conversationId/courseId/sectionId used to reach
  // getOwnedConversationOrNull/courseScopeFromAuthContext/
  // startSectionConversation's own eq() calls completely unvalidated -- a
  // malformed value (not JSON-invalid, just not UUID-shaped) raised
  // Postgres's own "invalid input syntax for type uuid", which the generic
  // error handler (server/index.ts) turns into a 503 "try again later" for
  // what is a permanent client error -- utils/uuid.ts's UUID_RE doc comment
  // names this exact failure mode, already fixed at every OTHER UUID path
  // param in the codebase. `kind`'s own validation (#308, just below) is
  // folded into this same envelope instead of staying a separate manual
  // check now that there's a natural place for it.
  const envelopeParsed = chatEnvelopeSchema.safeParse(rawBody);
  if (!envelopeParsed.success) {
    return c.json(
      { error: "conversationId/courseId/sectionId must be valid UUIDs when present; kind must be 'tutor' or 'section'" },
      400,
    );
  }
  // `messages` stays an unchecked cast here, same as the ChatRequestBody
  // cast this replaced -- every element gets real validation via
  // historyMessageSchema/inboundUserMessageSchema below; this is only the
  // top-level "is it an array at all" shape.
  const uiMessages = (rawBody as ChatRequestBody).messages;
  if (!Array.isArray(uiMessages) || uiMessages.length === 0) {
    return c.json({ error: "messages is required" }, 400);
  }
  // #308: no bound previously existed on the array's own length (only on
  // parts-per-message and text-part length, above). See
  // MAX_MESSAGES_PER_REQUEST's doc comment for why this is generous relative
  // to MAX_HISTORY_MESSAGES.
  if (uiMessages.length > MAX_MESSAGES_PER_REQUEST) {
    return c.json(
      { error: `messages must contain at most ${MAX_MESSAGES_PER_REQUEST} entries`, code: "history_too_long" },
      400,
    );
  }
  // #264: every element, not just the tail -- see historyMessageSchema's
  // doc comment. Runs before the tail-specific check below so a forged
  // element anywhere in the array 400s the same way a forged tail would.
  for (const m of uiMessages) {
    if (!historyMessageSchema.safeParse(m).success) {
      return c.json(
        { error: "Every message must have role \"user\" or \"assistant\" and a well-formed parts array" },
        400,
      );
    }
  }

  // Full history vs. incremental (#3 pitfall 3): only the LAST message --
  // the one just typed -- is trusted for anything, regardless of what
  // `uiMessages` actually contains.
  //
  // #317 review, #353: as of prepareSendMessagesRequest (client/App.tsx),
  // a real browser client trims the REQUEST BODY to that one message
  // before it's ever sent -- `uiMessages` here is length 1 on every real
  // turn, not the whole array useChat's own local state still holds
  // client-side. This route still validates every element defensively
  // (#264, above) and still only trusts the last one for anything: a
  // caller that bypasses the browser (and its trim) can still POST a
  // longer array directly, and nothing before the last entry gets
  // persisted or reaches the model either way -- #143 stopped building the
  // model's context from this client-supplied array at all (see the
  // persistedHistory fetch further down).
  const inboundMessage = uiMessages[uiMessages.length - 1];
  const parsedInbound = inboundUserMessageSchema.safeParse(inboundMessage);
  if (!parsedInbound.success) {
    return c.json({ error: "The last message must be a user message with a non-empty parts array" }, 400);
  }

  const db = makeDb(c.env.DATABASE_URL);

  const resolveNow = () => resolveConversation(c, db, authContext, envelopeParsed.data, inboundMessage);

  // #279 (requirement 2), scoped deliberately narrower than the issue asks.
  //
  // The issue says "run the rate-limit check and conversation resolution
  // concurrently with Promise.all". Done literally -- wrapping
  // reserveRateLimitSlot and resolveConversation in one Promise.all -- that
  // is UNSAFE, and an earlier pass on this route rejected it for exactly
  // that reason: resolveConversation is not one call, it is a three-way
  // branch, and two of those branches WRITE. `kind: "section"` runs
  // startSectionConversation and the tutor fallthrough runs
  // createConversation (both above in this file), so a request that ends up
  // 429'd would still have minted a conversation row that nothing goes on
  // to use or clean up -- a permanent orphan produced by a request the
  // server told the client it refused.
  //
  // What IS safe is the branch the issue's own evidence table actually
  // names as its "step 2": the `conversationId` branch, which is
  // getOwnedConversationOrNull -> getConversationById, a single SELECT with
  // no write anywhere in it (repositories/conversations.ts). Racing THAT
  // against the reservation can leave nothing behind, because it creates
  // nothing. So the preflight below is gated on the same `conversationId`
  // truthiness check resolveConversation itself branches on -- when it's
  // set, we are provably on the read-only branch; when it isn't, resolution
  // stays strictly behind the rate-limit gate, exactly as before. This is
  // also the dominant case: every turn after a conversation's first one
  // carries a conversationId.
  //
  // Three properties make this safe rather than merely convenient:
  //   1. No data dependency either way. reserveRateLimitSlot takes
  //      (db, userId, now, windowMs) and resolveConversation takes the
  //      envelope; neither reads the other's result.
  //   2. Strictly separate resources. The reservation touches only
  //      chatRateLimitWindows, keyed (userId, windowStart); the preflight
  //      touches only conversations/courses. They cannot serialize against
  //      or deadlock each other.
  //   3. The 429 still wins. The reservation is awaited FIRST and returns
  //      before the preflight is ever unwrapped, so a rate-limited request
  //      returns the same 429 it always did -- it never returns a 404/403
  //      the preflight happened to resolve first.
  //
  // The `.then(ok, err)` wrapper (rather than handing the bare promise
  // around) is load-bearing: this promise is DISCARDED on the 429 path, so
  // it must never reject. A bare rejection would surface as an unhandled
  // rejection, and a Promise.all-style await would let a transient Neon
  // blip on the read turn a legitimate 429 into a 503. Rejections are
  // captured here and rethrown below, on the non-429 path only, preserving
  // today's error behaviour byte for byte.
  //
  // Cost of the trade: a request that goes on to 429 now issues one read it
  // will not use. That is bounded by the rate limiter itself (which has
  // already charged the request either way) and is a wasted read, never a
  // wasted write.
  const preflightResolution = envelopeParsed.data.conversationId
    ? resolveNow().then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      )
    : undefined;

  // #219/#265: per-user rate limit, checked (and incremented, atomically,
  // in the same statement) before any persistence or model call. 429 +
  // Retry-After, surfaced through useChat's existing #144 error row (its
  // onError sees the response status; the retryable row already wires
  // `regenerate`). Unconditional -- every request that reaches this line
  // consumes a slot, whether or not it goes on to call the model, which is
  // deliberately more conservative than "only count requests that actually
  // reach streamText": it closes every gap that shape could reopen, at the
  // cost of also counting a request that will 400/404/409 moments later.
  const requestCount = await reserveRateLimitSlot(
    db,
    authContext.session.userId,
    new Date(),
    RATE_LIMIT_WINDOW_MS,
  );
  if (requestCount > RATE_LIMIT_MAX_PER_MINUTE) {
    return c.json(
      {
        error: "You're sending messages too quickly. Please wait a moment and try again.",
        code: "rate_limited",
      },
      429,
      { "Retry-After": String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)) },
    );
  }

  // #312: conversation resolution extracted to its own function -- see
  // resolveConversation's own doc comment. Early-exit cases (404/403/400/409)
  // come back as a Response to return directly.
  //
  // #279: on the read-only `conversationId` branch this promise was already
  // started above and has been running alongside the reservation -- awaiting
  // it here costs whatever is left of it, not a fresh round-trip. Every
  // other branch (the two that can CREATE a conversation) still starts here,
  // after the 429 gate, and is unchanged.
  let resolved: Awaited<ReturnType<typeof resolveConversation>>;
  if (preflightResolution) {
    const settled = await preflightResolution;
    if (!settled.ok) throw settled.error;
    resolved = settled.value;
  } else {
    resolved = await resolveNow();
  }
  if (resolved instanceof Response) return resolved;
  const { conv, sectionGreetingParts, sectionGreetingMessageId } = resolved;

  // Row just read back (and ownership-checked) or just created under a
  // verified scope -- the sanctioned case for this cast per scope.ts's
  // unsafeCourseScope docstring.
  const scope = unsafeCourseScope(conv.courseId);

  // #317 review, #326: these three reads have no data dependency on each
  // other -- each only needs `conv`/`scope`, already resolved above -- so
  // one Promise.all replaces three serialized Neon HTTP round-trips with
  // one (the slowest of the three), instead of the sum of all three.
  // resolvePromptTemplate (the "no pin" fallback branch below) is the one
  // exception: it genuinely needs orgScope's result as an input, so it
  // can't join this batch -- it runs after, only on the conversations that
  // reach it (predate promptTemplateId, or never resolved a real template
  // at creation).
  const [{ orgScope, courseLlmConfigId }, pinnedPromptContent, sectionPromptContext] = await Promise.all([
    // #25/#26: both prompt-template and LLM-config resolution need the org
    // scope for their own fallback queries -- resolved once and shared,
    // rather than each doing its own getOrgScopeForCourse round-trip.
    //
    // #317 review, #326 (remaining requirement), #346 (requirement 1):
    // resolveConversation's conversationId branch already reads both
    // orgScope AND courseLlmConfigId off the same getConversationById row
    // (joined against courses) -- the dominant case, since most turns are
    // on an already-existing conversation, not a brand-new one. Falls back
    // to a real query only for the two conversation-creation branches,
    // which don't resolve either for free from their own queries; that
    // fallback fetches both together (getOrgScopeAndLlmConfigForCourse)
    // rather than two separate round-trips.
    resolved.orgScope !== undefined
      ? Promise.resolve({ orgScope: resolved.orgScope, courseLlmConfigId: resolved.courseLlmConfigId ?? null })
      : getOrgScopeAndLlmConfigForCourse(db, scope).then(
          (r) => r ?? { orgScope: null, courseLlmConfigId: null },
        ),
    // #25: system prompt, resolved from the conversation's PINNED template
    // (set once at creation/restart -- see lib/prompts.ts's module doc
    // comment) rather than re-resolved here. A null promptTemplateId means
    // either a genuinely-unset scope (DEFAULT_SYSTEM_PROMPT was already the
    // right answer at creation) or a conversation that predates this column
    // -- both degrade the same way: resolve fresh below rather than fail
    // the turn over a missing pin.
    conv.promptTemplateId ? getPinnedPromptTemplateContent(db, conv.promptTemplateId) : Promise.resolve(null),
    conv.sectionId ? getSectionPromptContext(db, scope, conv.sectionId) : Promise.resolve(null),
  ]);

  // #317 review, #325: `isDefaultPrompt` tracks whether resolution ever
  // actually hit a real prompt_templates row -- a PINNED id is by
  // definition a real row (DEFAULT_SYSTEM_PROMPT is never pinned, see
  // ResolvedPromptTemplate.id's own doc comment), so only the two
  // no-pin branches can set it true. Passed to assembleSystemPrompt so
  // TUTOR_GUARDRAIL is appended only for the code-level fallback, never a
  // project's own template (see that constant's doc comment).
  let resolvedSystemPromptContent: string;
  let isDefaultPrompt: boolean;
  if (pinnedPromptContent !== null) {
    resolvedSystemPromptContent = pinnedPromptContent;
    isDefaultPrompt = false;
  } else if (orgScope) {
    // #317 review, #346 (requirement 2): passes the homeworkId
    // getSectionPromptContext already resolved one statement earlier
    // (sectionPromptContext?.homeworkId) instead of letting
    // resolvePromptTemplate re-read `sections` for the exact same column --
    // `?? null` when sectionPromptContext itself is null (tutor-kind, or a
    // section that failed to resolve within scope) matches
    // resolvePromptTemplate's own "no sectionId -> no homework level" and
    // "sectionId didn't resolve -> no homework level" behavior either way.
    const resolved = await resolvePromptTemplate(
      db,
      orgScope,
      scope,
      conv.sectionId,
      sectionPromptContext?.homeworkId ?? null,
    );
    resolvedSystemPromptContent = resolved.content;
    isDefaultPrompt = resolved.id === null;
    // #317 review, #326: "a null pin re-runs the full 4-scope template walk
    // on every message forever" -- write the resolved id back the first
    // time a real template is actually found for a conversation that
    // reached this branch (predates promptTemplateId, or resolved to
    // nothing at creation and a template has since been added). Every
    // later turn then takes the pinned fast path above instead of
    // repeating this walk. Best-effort: a write failure here must not fail
    // the turn -- caught and logged, not thrown -- the walk simply runs
    // again next time, same as today.
    //
    // #317 review, code-review follow-up: awaited, not fire-and-forget.
    // This used to be `.catch()`'d without an `await` -- on Cloudflare
    // Workers, a promise that's neither awaited nor registered with
    // `c.executionCtx.waitUntil()` isn't guaranteed to run to completion
    // once the handler's synchronous work is done, which is exactly the
    // "best-effort" this write is supposed to be, not "maybe never
    // happens for reasons unrelated to its own .catch()". This only
    // fires once per conversation (every later turn takes the pinned
    // fast path above), so the extra round-trip here is not a
    // steady-state cost.
    if (resolved.id !== null && conv.promptTemplateId === null) {
      await pinConversationPromptTemplate(db, conv.id, resolved.id).catch((err) => {
        logServerError("chatHandler.pinPromptTemplate", err);
      });
    }
  } else {
    resolvedSystemPromptContent = DEFAULT_SYSTEM_PROMPT;
    isDefaultPrompt = true;
  }
  // #317 review, blocking finding #4: an unreleased section (draft,
  // scheduled, or hidden/expired) must not leak its content into the model's
  // context, even for a conversation that started while it was live -- see
  // PromptSectionContext.isUnreleased's own doc comment. Collapses to the
  // same "Section not found" 404 startSectionConversation's own equivalent
  // gate (repositories/sectionConversations.ts) returns, so this stays
  // indistinguishable from a genuinely missing section, same rationale as
  // every sibling release gate in this codebase (#172 audit).
  if (sectionPromptContext?.isUnreleased && !authContext.canViewDraftsIn(conv.courseId)) {
    return c.json({ error: "Section not found", code: "not_found" }, 404);
  }
  // #80: systemPrompt assembly moved below, past the replay/idempotency
  // check -- see the isHintRequest handling right after it for why: a
  // "replay" (the model already answered; the client just never received
  // it, #3 requirement 6) must NOT grant a second hint for the same
  // original request, so the grant/deny decision has to happen AFTER
  // classifyTurn has ruled that out, not before.

  // #26: model/provider, resolved per-request from the homework's
  // llm_config_id override (if this is a section conversation) or the org's
  // default config -- replaces the hardcoded model. Not pinned/cached on
  // the conversation row the way #25's prompt template is (that's the
  // cross-cutting invariant's stated ideal; out of scope for this pass,
  // same "known gap, tracked separately" posture as #258 -- see #26's own
  // closing comment). No org scope at all (a course whose org lookup
  // failed) can't resolve any config; treated the same as "no config
  // found" rather than a separate error path.
  if (!orgScope) {
    logServerError("chatHandler.llmConfig", new Error(`No org scope for course ${scope}`));
    // #317 review, #344: names the actual classification so the student
    // sees the purpose-written "problem on our side, not yours" copy
    // (packages/ui's readErrorMessage) instead of falling to the codeless
    // default -- a permanent misconfiguration presented with a Retry
    // button that can never succeed.
    return c.json({ error: "Something went wrong. Please try again later.", code: "unavailable" }, 503);
  }
  let resolvedLLMConfig: Awaited<ReturnType<typeof resolveLLMConfig>>;
  try {
    resolvedLLMConfig = await resolveLLMConfig(
      db,
      orgScope,
      scope,
      sectionPromptContext?.homeworkLlmConfigId ?? null,
      courseLlmConfigId,
    );
  } catch (err) {
    if (err instanceof LLMConfigNotFoundError) {
      logServerError("chatHandler.llmConfig", err);
      return c.json(
        {
          error: `I'm sorry, but there's no valid LLM configuration available right now. Reference ID: ${err.referenceId}`,
          code: "unavailable",
        },
        500,
      );
    }
    throw err;
  }
  let resolvedApiKey: string;
  let providerClient: ReturnType<typeof buildProviderClient>;
  try {
    // #317 review, security finding #323: c.env is passed through with its
    // real Env type now -- resolveApiKey itself confines the one genuinely
    // dynamic lookup (an allowlisted binding name) to a single scoped cast,
    // instead of this call site erasing the whole Env contract.
    resolvedApiKey = await resolveApiKey(c.env, db, orgScope, resolvedLLMConfig);
    // #333: LLMOXIE_BASE_URL overrides the gateway host (lib/ai.ts's own
    // LLMOXIE_DEFAULT_BASE_URL otherwise) -- unset for every provider that
    // isn't llmoxie, and buildProviderClient ignores it for those.
    providerClient = buildProviderClient(resolvedLLMConfig.provider, resolvedApiKey, {
      llmoxieBaseUrl: c.env.LLMOXIE_BASE_URL,
    });
  } catch (err) {
    if (err instanceof LLMCredentialMissingError || err instanceof UnsupportedLLMProviderError) {
      const referenceId = crypto.randomUUID();
      logServerError("chatHandler.llmConfig", new Error(`${err.message} (ref: ${referenceId})`));
      return c.json(
        {
          error: `I'm sorry, but there's no valid LLM configuration available right now. Reference ID: ${referenceId}`,
          code: "unavailable",
        },
        500,
      );
    }
    throw err;
  }

  // Idempotency (#3, reworked #213) -- two distinct retry shapes, both
  // covered so neither the user row nor the assistant row can be
  // double-written:
  //
  //   1. "Not answered yet": the user message already landed but the
  //      assistant hasn't responded (or its response hasn't been persisted)
  //      yet -- last row is this exact user message. Skip the insert, fall
  //      through to a normal model call (which will produce and persist the
  //      still-missing assistant reply).
  //   2. "Already answered": the model already ran AND its response is
  //      already persisted for this exact user turn -- last row is the
  //      assistant reply, and the row before it is this exact user message.
  //      The client just never received that response (dropped after the
  //      last streamed byte, client-side timeout, etc). Skip the insert AND
  //      the model call entirely -- replay the persisted assistant message
  //      instead, so retrying can't produce a second user/assistant row
  //      pair or a second (paid) model call.
  //
  // Both cases key off the AI SDK's own per-send UIMessage id
  // (clientMessageId, persisted alongside the row -- see the messages
  // schema's #213 doc comment) instead of comparing message content: a
  // student legitimately sending the same text twice ("yes", "ok", "why?"
  // -- the highest-frequency replies in a Socratic tutor) gets a NEW id
  // each send, so it is correctly treated as a new message, not a retry of
  // the old one.
  // #317 review, #322: claims the per-conversation turn lock BEFORE the
  // idempotency read below, not just around the model call -- the race
  // Cordero found (two concurrent sends interleaving into Q_a, Q_b, A_a,
  // A_b, and a lost-response retry permanently 409ing even though the real
  // answer was already persisted) happens in the read-classify-write
  // sequence itself, not only in streamText. A second concurrent request on
  // this same conversation gets a distinct, retryable 409 immediately,
  // rather than being allowed to race through this same sequence.
  // acquireConversationTurnLock's own doc comment (repositories/
  // conversations.ts) covers the staleness/abandoned-lock case.
  const lockAcquired = await acquireConversationTurnLock(db, conv.id, LOCK_STALE_MS);
  if (!lockAcquired) {
    // #317 review, #344: matches the other two 409s on this route
    // (the section-not-interactive gate, the idempotency-conflict catch
    // below), which already carry this code -- readErrorMessage
    // (packages/ui) renders it as "Already sending", retryable.
    return c.json(
      {
        error: "Another message for this conversation is still being processed. Please wait a moment and try again.",
        code: "in_progress",
      },
      409,
    );
  }

  // #317 review, #326: one fetch, sized for the model's context window
  // (MAX_HISTORY_MESSAGES), instead of a `limit: 2` idempotency-only read
  // followed by a SECOND, separate `limit: 40` read further down for the
  // model context -- the second read's own result differs from this one by
  // at most the single row the "insert" branch below is about to write, so
  // it's cheaper to append that row in memory (persistedHistory below) than
  // to re-fetch the same window from Postgres a second time. `recentMessages`
  // is also what backs the idempotency check immediately below, same as the
  // old `limit: 2` read (its first two elements).
  //
  // #279: skipOwnershipCheck -- `conv` above already proved this
  // conversation is in scope (getOwnedConversationOrNull, or a row this
  // same request just created/raced onto inside resolveConversation), so
  // re-running the same id/courseId/isDeleted select here would be a
  // redundant round-trip.
  //
  // #317 review, #350 (requirement 1): wrapped in its own try/catch that
  // releases the lock before rethrowing -- the handler's own comment further
  // down ("everything from here through streamText... if any of it throws,
  // the lock must be released here") stated the intent, but the try/catch
  // that actually implements it didn't start until AFTER this call. A
  // transient Neon blip here used to leak the lock: the request still 503s
  // (app.onError), but processing_started_at stayed set, so every send on
  // this conversation 409'd for the next LOCK_STALE_MS -- the student
  // follows the 503's own "try again" advice into a false "already being
  // processed" error.
  let recentMessages: Awaited<ReturnType<typeof getLastMessages>>;
  try {
    recentMessages = await getLastMessages(db, scope, conv.id, MAX_HISTORY_MESSAGES, {
      skipOwnershipCheck: true,
    });
  } catch (err) {
    await releaseConversationTurnLock(db, conv.id).catch(() => {});
    throw err;
  }
  const [lastMessage, secondLastMessage] = recentMessages;
  const initialClassification = classifyTurn(lastMessage, secondLastMessage, parsedInbound.data.id);

  if (initialClassification === "replay") {
    // No model call is about to happen -- release immediately rather than
    // holding the lock until LOCK_STALE_MS expires for no reason.
    // #317 review, #350 (requirement 1): logged, not swallowed -- unlike
    // the outer catch's own release (which is about to re-throw the
    // original error anyway, so a release failure there is secondary
    // noise), this path returns a normal 200 with nothing else to surface
    // a stuck lock. Best-effort: a failure here still self-heals via
    // LOCK_STALE_MS, same as every other release call on this route.
    await releaseConversationTurnLock(db, conv.id).catch((err) => {
      logServerError("chatHandler.releaseLock.replay", err);
    });
    return replayResponse(conv.id, lastMessage!.parts);
  }

  // #80: deterministic hint grant/deny -- the primary, tested hint-request
  // path (see ChatRequestBody.isHintRequest's own doc comment; the
  // requestHint TOOLS entry above is a secondary, model-mediated path that
  // shares this same recordHintRequest call). Runs here -- past the replay
  // check above, under the turn lock already acquired, before any model
  // call -- so: (1) a "replay" retry of an already-answered turn can never
  // grant a second hint for the same original request; (2) concurrent sends
  // on this SAME conversation are serialized by the lock, same as every
  // other per-turn side effect on this route (recordHintRequest's own doc
  // comment names the one race this does NOT close -- a different
  // conversation/tab for the same student+section -- as an accepted
  // simplification, not a security boundary). A budget-exceeded request
  // short-circuits here with no model call: cheap, deterministic, and
  // independently testable (chat.test.ts) without mocking streamText.
  let isHintGranted = false;
  if (envelopeParsed.data.isHintRequest === true && conv.sectionId) {
    // Matches the getLastMessages call above and the appendMessage call
    // below: any throw between lock acquisition and the streamText try
    // block must release the lock itself before propagating, or a
    // transient failure here leaves the conversation "processing" for the
    // full LOCK_STALE_MS with nothing else to release it.
    let hintResult: Awaited<ReturnType<typeof recordHintRequest>>;
    try {
      hintResult = await recordHintRequest(db, orgScope, {
        conversationId: conv.id,
        sectionId: conv.sectionId,
        studentId: authContext.session.userId,
        promptTemplateId: conv.promptTemplateId,
      });
    } catch (err) {
      await releaseConversationTurnLock(db, conv.id).catch(() => {});
      throw err;
    }
    if (hintResult.status === "budget_exceeded") {
      await releaseConversationTurnLock(db, conv.id).catch((err) => {
        logServerError("chatHandler.releaseLock.hintBudgetExceeded", err);
      });
      return c.json(
        {
          error: "You've used all the hints available for this section.",
          code: "hint_budget_exceeded",
          remainingHints: 0,
        },
        429,
      );
    }
    isHintGranted = true;
  }
  // #80: assembled here (not at this route's earlier prompt-resolution
  // point) so isHintGranted above is known first -- see prompts.ts's own
  // assembleSystemPrompt doc comment for HINT_INSTRUCTION's placement/
  // trust rationale (this flag is never taken from the client at face
  // value; recordHintRequest above is what actually decided it).
  // #168: only assembled for a section-kind conversation -- markSectionComplete
  // is withheld entirely from the model's tool list on a tutor-kind one
  // (toolsForConversation, this file's own TOOLS catalog, below), so
  // instructing the model about a tool it was never offered would be dead
  // prompt text. `resolvedLLMConfig.markCompleteInstruction` is the
  // per-config override (#168's own "tunable per LLM config, not
  // hardcoded" requirement); DEFAULT_MARK_COMPLETE_INSTRUCTION is the
  // fallback for every config that hasn't set one (the common case today).
  const markCompleteInstruction = conv.sectionId
    ? (resolvedLLMConfig.markCompleteInstruction ?? DEFAULT_MARK_COMPLETE_INSTRUCTION)
    : undefined;
  const systemPrompt = assembleSystemPrompt(
    resolvedSystemPromptContent,
    sectionPromptContext ?? undefined,
    isDefaultPrompt,
    isHintGranted,
    markCompleteInstruction,
  );

  // #317 review, #326: "skip-insert" means `recentMessages[0]` already IS
  // the inbound message (that's classifyTurn's own definition of this
  // case) -- persistedHistory starts as `recentMessages` unmodified and
  // only the "insert" branch below needs to change it, by prepending the
  // row it's about to write.
  let persistedHistory: MessageHistoryRow[] = recentMessages;
  if (initialClassification === "insert") {
    // #266: appendMessage's return value used to be discarded entirely, so
    // a reused clientMessageId with different content silently dropped the
    // new message while the call below still ran the model against it --
    // caught locally (not left to server/index.ts's global onError, though
    // that mapping stays as a safety net) so a well-formed conflict 409s
    // with the same request/response shape every other refusal on this
    // route already uses.
    try {
      const { row: insertedRow, created } = await appendMessage(
        db,
        scope,
        conv.id,
        { role: "user", parts: inboundMessage.parts, clientMessageId: parsedInbound.data.id },
        { skipOwnershipCheck: true },
      );
      // #273: `created: false` means this request LOST a race against
      // another one carrying the same clientMessageId (double-fired send,
      // a duplicated tab, a fetch-layer retry -- the exact scenarios #254's
      // own doc comment names) -- appendMessage resolved to the WINNER's
      // already-persisted row instead of making a new one. Both requests
      // used to sail past this point regardless and both call streamText
      // below: two paid model calls, two assistant rows, for one student
      // turn. The loser re-runs the SAME idempotency read the top of this
      // block already does -- the winner may have finished (and persisted
      // a reply) by the time this read happens -- and either replays that
      // reply or, if the winner is still mid-flight, tells the client to
      // wait rather than also calling the model.
      if (!created) {
        // #322: the lock above prevents this within one conversation under
        // normal circumstances -- this remains reachable only via the
        // staleness escape hatch (acquireConversationTurnLock's own doc
        // comment), so it stays as a defensive backstop rather than dead
        // code. A genuine re-fetch, unlike persistedHistory above -- this
        // request's own recentMessages snapshot predates the race winner's
        // write, so it cannot be reused here the way the normal path reuses
        // its own snapshot.
        const [raceLast, raceSecondLast] = await getLastMessages(db, scope, conv.id, 2, {
          skipOwnershipCheck: true,
        });
        // #317 review, #350 (requirement 1): logged, not swallowed -- both
        // branches below return a normal response with nothing else to
        // surface a release failure, same reasoning as the top-level replay
        // release above.
        if (classifyTurn(raceLast, raceSecondLast, parsedInbound.data.id) === "replay") {
          await releaseConversationTurnLock(db, conv.id).catch((err) => {
            logServerError("chatHandler.releaseLock.raceReplay", err);
          });
          return replayResponse(conv.id, raceLast!.parts);
        }
        await releaseConversationTurnLock(db, conv.id).catch((err) => {
          logServerError("chatHandler.releaseLock.raceConflict", err);
        });
        // #317 review, #344: same code as the lock-acquisition 409 above --
        // both are "a turn is already in flight for this conversation",
        // just detected at different points.
        return c.json(
          { error: "This message is already being processed. Please wait a moment.", code: "in_progress" },
          409,
        );
      }
      // #317 review, #326: the row this call just wrote, prepended ahead of
      // the pre-insert snapshot -- exactly what a fresh
      // `getLastMessages(MAX_HISTORY_MESSAGES)` read would return post-insert
      // (newest-first, capped at the same limit), without actually
      // re-reading it from Postgres. role/parts come from the input this
      // handler itself constructed the insert from (already known, not
      // re-derived from appendMessage's returned row) -- only `id` is
      // server-generated and genuinely needs the DB round-trip's result.
      persistedHistory = [
        { id: insertedRow.id, role: "user", parts: inboundMessage.parts },
        ...recentMessages.slice(0, MAX_HISTORY_MESSAGES - 1),
      ];
    } catch (err) {
      // #317 review, #350 (requirement 1): `.catch(() => {})`, matching the
      // outer catch's own release below -- this catch can re-throw `err`
      // itself (the `throw err` branch), and a release failure surfacing
      // here would mask the original error the caller actually needs to
      // see. Best-effort: a stuck lock still self-heals via LOCK_STALE_MS.
      await releaseConversationTurnLock(db, conv.id).catch(() => {});
      if (err instanceof IdempotencyKeyConflictError) {
        // #266: `duplicate_message`, NOT the `in_progress` the route's other
        // two 409s use. Those two mean "a turn is genuinely in flight, try
        // again shortly" and readErrorMessage (packages/ui) renders them
        // retryable. This one is permanent: the id in this request already
        // identifies DIFFERENT stored content, so an identical re-send is
        // refused identically every time. Sharing the code offered a retry
        // that could not succeed and told the student a message that was
        // REFUSED was "already on its way" -- the same conflation
        // section_closed was carved out of in_progress to fix.
        return c.json({ error: err.message, code: "duplicate_message" }, 409);
      }
      throw err;
    }
  }

  // #317 review, #322: everything from here through the streamText call
  // below is synchronous setup on the way to a held-open stream -- if any
  // of it throws, the lock must be released here (the success path's
  // release lives in onFinish, which only fires once the stream actually
  // starts). Not needed for correctness under the current code (nothing
  // between here and streamText is expected to throw), but the alternative
  // -- a stuck lock silently blackholing a conversation for LOCK_STALE_MS
  // -- is a worse failure mode than the extra try/catch.
  try {
    // #143: server-authoritative context, not the client's own copy. The old
    // behavior forwarded the client-supplied `uiMessages` array (trailing-
    // windowed) straight to convertToModelMessages -- only its LAST entry was
    // ever validated (parsedInbound above), so a crafted array could inject
    // fabricated assistant replies or a smuggled system-role message ahead of
    // it, overriding the Socratic guardrail (the exact academic-integrity
    // bypass this issue's "Trust boundary on history" requirement calls out).
    // Built from the row(s) this handler itself just confirmed or wrote above
    // (persistedHistory, computed alongside the idempotency check -- #326)
    // closes that: everything the model sees is either a prior assistant
    // reply the server generated, or a prior user message this same
    // idempotency check already accepted. persistedHistory is newest-first
    // (matches getLastMessages' own order); reversed here into the
    // chronological order the model needs. Same MAX_HISTORY_MESSAGES cap as
    // before (#215), just sourced server-side now instead of trusting the
    // client's own window.
    const modelMessages: UIMessage[] = [...persistedHistory].reverse().map((m) => ({
      id: m.id,
      role: m.role as UIMessage["role"],
      parts: m.parts as UIMessage["parts"],
    }));

    // #272: getLastMessages above only knows what's already persisted -- a
    // freshly-created section conversation's greeting was just written inside
    // startSectionConversation's own atomic group. Passed through explicitly
    // (not just assumed present in persistedHistory) so the model's very
    // first answer in a section actually sees the question (section.content,
    // embedded in the greeting) even in a test/mock configuration whose
    // getLastMessages fake doesn't reflect what a real write-then-read would
    // return.
    //
    // #317 review, #349 (requirement 4): only prepended when NOT already the
    // first element of modelMessages, by id (startSectionConversation's own
    // greetingMessageId -- the same id the greeting was persisted under).
    // On every real driver this repo runs (neon-http's db.batch, and
    // node-postgres's db.transaction fallback -- both awaited and committed
    // before this same request's own getLastMessages call above runs), the
    // greeting IS already in persistedHistory by the time this line runs;
    // unconditionally prepending it here previously produced
    // [greeting, greeting, user] on that path -- a real duplicate, not just
    // a hypothetical one, verified by reproducing it against a real
    // Postgres. The id check makes this correct on both that real path
    // (skips the duplicate) and the "not yet visible" case (still prepends,
    // preserving the original guarantee).
    // sectionGreetingMessageId != null guards the id comparison itself --
    // without it, a test/mock fixture that omits ids on both sides (the
    // greeting and its persisted-history fakes) would compare
    // undefined === undefined and wrongly conclude the greeting is already
    // present, silently dropping it instead of prepending. Only a REAL,
    // matching id counts as "already there."
    const greetingAlreadyInHistory =
      sectionGreetingMessageId != null && modelMessages.some((m) => m.id === sectionGreetingMessageId);
    const modelContextMessages: UIMessage[] =
      sectionGreetingParts && !greetingAlreadyInHistory
        ? [
            { id: sectionGreetingMessageId ?? crypto.randomUUID(), role: "assistant", parts: sectionGreetingParts } as UIMessage,
            ...modelMessages,
          ]
        : modelMessages;

    // #317 review, #321: latency for the llm_call_logs row written in
    // onFinish below -- captured right before the model call actually
    // starts, not at the top of chatHandler, so it reflects the LLM call
    // itself rather than this turn's own persistence/setup overhead.
    const turnStartedAt = Date.now();

    const result = streamText({
      // #26: model/provider/params all come from resolvedLLMConfig now --
      // homework override or org default, never hardcoded.
      model: providerClient(resolvedLLMConfig.modelName),
      system: systemPrompt,
      // #143: server-authoritative history (modelMessages, from
      // persistedHistory above), not a client-supplied array -- see
      // persistedHistory's own doc comment for the trust-boundary rationale
      // this closes.
      messages: convertToModelMessages(modelContextMessages),
      // #264: belt-and-suspenders alongside historyMessageSchema's role
      // allowlist above -- the SDK warns and proceeds by default (its own
      // words: "a security risk because they may enable prompt injection
      // attacks"). This makes a role:"system" element a hard model-input
      // refusal even if some future change to that schema let one through.
      allowSystemInMessages: false,
      // #168: section-kind-only tools (markSectionComplete) withheld
      // entirely for a tutor-kind conversation -- see toolsForConversation's
      // own doc comment (this file's TOOLS catalog, above) for why this is
      // real gating, not a prompt instruction alone.
      //
      // Final-review fix wave, #80 finding (hint double-grant): also
      // withholds requestHint for this exact turn when isHintGranted is
      // true -- the envelope path (above) already recorded a hintEvents row
      // for this turn before streamText was ever reached, so the model has
      // no legitimate reason to call requestHint again this turn. See
      // toolsForConversation's own doc comment for the full mechanism/
      // rationale, and its `withholdRequestHint` option's doc comment for
      // why the double-grant was possible without this.
      tools: toolsForConversation(conv.sectionId, { withholdRequestHint: isHintGranted }),
      // #80: threads request-scoped context into the requestHint tool's
      // execute() (its second argument's own `experimental_context` field)
      // -- see TOOLS.requestHint's own doc comment for why a static,
      // module-level ToolSet needs this instead of a closure. `sectionId`
      // is conv.sectionId as-is -- null only for a tutor-kind conversation,
      // where requestHint isn't in `tools` above at all, so this field is
      // simply unread on that path rather than driving an in-tool check.
      experimental_context: {
        db,
        orgScope,
        conversationId: conv.id,
        sectionId: conv.sectionId,
        studentId: authContext.session.userId,
        promptTemplateId: conv.promptTemplateId,
      } satisfies HintToolContext,
      // #80: strengthens TOOLS.requestHint's secondary path (see its own
      // doc comment above) -- when the model calls requestHint and it
      // grants a hint in one step, this injects the same HINT_INSTRUCTION
      // the primary isHintRequest envelope path uses into the system
      // prompt for the model's NEXT step, via ai@5.0.195's real per-step
      // `system` override (PrepareStepResult.system,
      // @ai-sdk/provider-utils -- confirmed present in the pinned
      // version's own .d.ts, not assumed). Returning undefined (steps[0],
      // or any step that didn't just get a granted requestHint result)
      // leaves the outer `system` above untouched for that step. Guarded
      // against double-injection: a turn where the ENVELOPE path already
      // granted (isHintGranted above, so `systemPrompt` already ends in
      // HINT_INSTRUCTION) skips this -- not a scenario recordHintRequest's
      // own idempotency window is expected to produce in practice, but the
      // guard is free either way. Loosely typed (TOOLS itself is declared
      // `: ToolSet`, so streamText's TOOLS generic can't narrow `steps`'
      // tool-result shape any further than this file's other tool-facing
      // code already accepts, e.g. requestHint's own execute() cast).
      prepareStep: ({ steps }) => {
        const lastStep = steps[steps.length - 1];
        const grantedHint = lastStep?.toolResults?.some(
          (r) =>
            (r as { toolName?: string }).toolName === "requestHint" &&
            (r as { output?: { status?: string } }).output?.status === "hint_provided",
        );
        if (grantedHint && !systemPrompt.includes(HINT_INSTRUCTION)) {
          return { system: `${systemPrompt}\n\n${HINT_INSTRUCTION}` };
        }
        return undefined;
      },
      temperature: resolvedLLMConfig.temperature,
      maxOutputTokens: resolvedLLMConfig.maxCompletionTokens,
      // #317 review, #349: see SUPPORTS_REASONING_EFFORT_NONE's own doc
      // comment -- this is what actually keeps `temperature` above from
      // being silently dropped for the gpt-5.1-5.4 family.
      providerOptions: SUPPORTS_REASONING_EFFORT_NONE.test(resolvedLLMConfig.modelName)
        ? { openai: { reasoningEffort: "none" } }
        : undefined,
      /* Allow up to 5 steps so the model can call a display tool and then
         continue with the follow-up Socratic question in the same turn.
         Without this, streamText stops the moment a tool call is emitted. */
      stopWhen: stepCountIs(5),
      // #143: bounds how long a stuck/hanging upstream can hold this request
      // open. A genuine provider error (including a 429) already arrives as
      // an in-stream `error` chunk well before this fires (ai@5.0.195 -- see
      // hasRenderableContent's doc comment); this specifically covers the
      // "upstream never responds at all" case that chunk-based handling
      // can't, by construction, ever see.
      abortSignal: AbortSignal.timeout(STREAM_TIMEOUT_MS),
      // #317 review, #321: a genuine failure in stream construction/
      // processing itself -- e.g. a malformed request the provider rejects
      // before any token streams. Distinct from a provider error mid-
      // generation, which ai@5.0.195 delivers as an in-stream `error` chunk
      // instead (handled by onFinish's finishReason check below), not a
      // rejection this callback would ever see. Previously silent: the
      // SDK's own default is a bare console.error with no request context
      // this app could act on -- "zero evidence" was #321's whole complaint.
      onError: ({ error }) => {
        // #275: previously folded conversationId/userId/provider/model into
        // the Error's own message string via template literal -- readable
        // in a single console line, but not a field a log query can filter
        // or group on. Passed as structured `extra` context instead (see
        // logServerError's own doc comment), same data, greppable now.
        logServerError("chatHandler.streamText.onError", error instanceof Error ? error : new Error(String(error)), {
          conversationId: conv.id,
          userId: authContext.session.userId,
          provider: resolvedLLMConfig.provider,
          model: resolvedLLMConfig.modelName,
        });
      },
      // Fires specifically when abortSignal (STREAM_TIMEOUT_MS above)
      // actually trips -- a stuck/hanging upstream that never errored and
      // never finished, not a provider-reported failure. Logged under its
      // own label so an operator can tell "the model is slow" apart from
      // "the model is erroring" without guessing from timing alone.
      onAbort: () => {
        logServerError(
          "chatHandler.streamText.onAbort",
          new Error(
            `LLM call timed out after ${STREAM_TIMEOUT_MS}ms for conversation ${conv.id}, provider ${resolvedLLMConfig.provider}, model ${resolvedLLMConfig.modelName}`,
          ),
        );
      },
    });

    return result.toUIMessageStreamResponse({
      headers: { "x-conversation-id": conv.id },
      // #317 review, #321 + "strongly recommend" item, #334: previously
      // absent, so the SDK's default error-to-string conversion reached the
      // client unfiltered -- combined with App.tsx rendering chatError.message
      // verbatim, a provider error (e.g. a raw 429 JSON body, "You're
      // sending messages too quickly...") reached the student exactly as
      // the provider phrased it. Logged for the same reason as streamText's
      // own onError above (this hook can fire for stream-processing errors
      // that one doesn't see).
      //
      // #334: a JSON envelope, not a bare sentence -- ConversationView's
      // readErrorMessage (packages/ui) parses `{error, code}` off this
      // string and classifies by `code`, the same contract every other
      // c.json({error, code}) response on this route already uses. A bare
      // string would classify as "unknown" and bury this sentence in the
      // "details for support" disclosure instead of the headline.
      // #275: `context: "chatHandler.stream"` -- distinct from
      // streamText's own "chatHandler.streamText.onError" above -- these are
      // genuinely different failure surfaces even though both handle "a
      // provider/stream error happened": streamText's onError sees an
      // in-stream `error` chunk (a provider failure mid-generation), while
      // THIS onError is the UI-message-stream wrapper's own hook, which can
      // also fire for a stream-processing failure that never produced an
      // `error` chunk at all. Kept separate on purpose so an operator can
      // tell which layer actually failed instead of one context string
      // conflating both.
      onError: (error) => {
        logServerError("chatHandler.stream", error instanceof Error ? error : new Error(String(error)), {
          conversationId: conv.id,
          userId: authContext.session.userId,
          model: resolvedLLMConfig.modelName,
        });
        return JSON.stringify({
          error: "The tutor stopped partway through. Nothing you wrote was lost.",
          code: "tutor_stopped",
        });
      },
      // The AI SDK's natural hook for persisting the assistant turn --
      // responseMessage is the full final UIMessage (text parts + any
      // tool-call/tool-result parts), exactly the shape `messages.parts`
      // (jsonb) is meant to store; no manual text+toolCalls reconstruction
      // needed. See the isErrorOutcome/hasRenderableContent doc comments
      // inside this callback for the persistence gate itself.
      onFinish: async ({ responseMessage, isAborted, finishReason }) => {
        // #268, #342: NOT persisted unless the turn reached a real terminal
        // state. Originally this was `isAborted || finishReason === "error"`
        // -- a denylist that let anything else through, including
        // `finishReason === undefined` and `"unknown"`. #342 found the gap
        // that denylist left: a client-side Stop or disconnect (not a
        // server-side abort -- ai@5.0.195's `isAborted` is set only by an
        // in-stream `abort` chunk, which the server emits only when its OWN
        // `abortSignal` (STREAM_TIMEOUT_MS) trips, never on a client reader
        // cancel) produces `isAborted: false` and `finishReason: undefined`,
        // which the denylist waved through as "success." An allowlist of
        // the finish reasons that actually mean "the model produced a real,
        // complete-as-far-as-it-went answer" closes that: "stop" (normal
        // completion), "length" (hit its token budget -- still a real
        // answer, not a truncation, so deliberately included), and
        // "tool-calls" (the model's last of the up-to-5 steps this route
        // allows ended on a tool call). Everything else -- undefined,
        // "unknown", "content-filter", "other", and "error" itself -- is
        // treated as not-a-real-answer and falls through to the same
        // not-persisted path an aborted/provider-error turn already took.
        const TERMINAL_FINISH_REASONS = new Set(["stop", "length", "tool-calls"]);
        const isErrorOutcome = isAborted || !finishReason || !TERMINAL_FINISH_REASONS.has(finishReason);

        // Persisting a rejected turn anyway would write a row the
        // idempotency replay path above (classifyTurn) would then treat as
        // "already answered" on every future retry -- for the finishReason
        // gate above, permanently serving the same half-sentence back with
        // no error and no way out except Restart (which voids the
        // submission); for hasRenderableContent's own gate (its own doc
        // comment), a permanently-empty assistant row. Not persisting
        // instead leaves nothing for this turn, so a retry's idempotency
        // check falls through to a genuine model call again.
        //
        // best-effort, not double-write-proof: if the *worker process* dies
        // before onFinish runs (vs. the client just disconnecting), the
        // assistant message is lost and the client's retry will only re-send
        // the user message (already deduped above), so no response ever gets
        // generated for that turn. That gap is a documented limitation (#3
        // pitfall 2), not fixed here -- tracked as #96 (streaming resilience).
        //
        // #317 review, #346 (requirement 3): the assistant message's id is
        // generated here rather than read back from an INSERT -- see
        // finalizeAssistantTurn's own doc comment for why that's what lets
        // the lock release, the message persist, and the llm_call_logs
        // write (previously three serialized round-trips, all directly
        // perceived as tail latency since the SDK awaits onFinish inside
        // the stream's flush) collapse into one db.batch()/transaction.
        const shouldPersist = !isErrorOutcome && hasRenderableContent(responseMessage.parts);
        // #275: the current equivalent of the old "hasRenderableContent
        // false -> bare return, nothing logged" branch -- that separate
        // early return doesn't exist anymore (#268/#342 folded it into this
        // one shouldPersist gate, above), so this is the single place that
        // now knows a turn is about to go unpersisted, for either reason
        // (isErrorOutcome, or a `stop`/`tool-calls` finish that still
        // produced no renderable content). Warn, not error: nothing threw --
        // this is the system correctly refusing to write a truncated/blank
        // row, but an operator debugging "the tutor showed my student an
        // error" needs to see it happened and why (finishReason/isAborted),
        // not infer it from a gap in the transcript.
        if (!shouldPersist) {
          logServerWarn("chatHandler.onFinish.noRenderableContent", "turn produced no persistable content", {
            conversationId: conv.id,
            userId: authContext.session.userId,
            model: resolvedLLMConfig.modelName,
            finishReason: finishReason ?? null,
            isAborted: Boolean(isAborted),
          });
        }
        const assistantMessage = shouldPersist
          ? { id: crypto.randomUUID(), parts: responseMessage.parts }
          : null;

        // #317 review, #321: one llm_call_logs row per turn -- including the
        // error/aborted/no-content cases above, which previously early-
        // returned with nothing written anywhere. This was the operational
        // gap #321 names: a provider outage or a rotated key produced
        // "zero evidence" -- no error rate, no per-provider breakdown, no
        // latency, no cost.
        // #317 review, #349 (requirement 3): result.totalUsage, not
        // result.usage -- the AI SDK documents result.usage as "the token
        // usage of the LAST STEP" only. stopWhen: stepCountIs(5) above
        // makes multi-step turns (a tool call, then a follow-up text
        // step) a designed path, and providers bill per call: result.usage
        // alone silently dropped every earlier step's tokens from cost
        // and usage reporting on any turn that used a tool.
        //
        // #317 review, #350 (requirement 2): raced against
        // USAGE_FETCH_TIMEOUT_MS -- see that constant's own doc comment for
        // why this Promise.all can hang forever on a genuinely cancelled
        // stream instead of merely resolving slowly. `finalizeAssistantTurn`
        // still runs on timeout (with null usage/cost fields, errorFlag
        // true), rather than onFinish just hanging and never reaching it at
        // all -- the lock still releases and a row still lands, even though
        // this specific turn's token/cost numbers are unknowable.
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const timedOut = Symbol("usage-fetch-timed-out");
        const timeoutPromise = new Promise<typeof timedOut>((resolve) => {
          timeoutHandle = setTimeout(() => resolve(timedOut), USAGE_FETCH_TIMEOUT_MS);
        });
        try {
          const usageResult = await Promise.race([
            Promise.all([result.totalUsage, result.response, result.warnings]),
            timeoutPromise,
          ]);
          clearTimeout(timeoutHandle);

          if (usageResult === timedOut) {
            logServerError(
              "chatHandler.onFinish.usageFetchTimedOut",
              new Error(
                `result.totalUsage/response/warnings never settled within ${USAGE_FETCH_TIMEOUT_MS}ms for conversation ${conv.id} -- likely a cancelled stream (#350); finalizing with null usage/cost`,
              ),
            );
            await finalizeAssistantTurn(db, conv.id, assistantMessage, {
              organizationId: orgScope,
              llmConfigId: resolvedLLMConfig.id,
              provider: resolvedLLMConfig.provider,
              model: resolvedLLMConfig.modelName,
              providerRequestId: null,
              inputTokens: null,
              outputTokens: null,
              costCents: null,
              latencyMs: Date.now() - turnStartedAt,
              errorFlag: true,
            });
            return;
          }

          const [usage, response, warnings] = usageResult;
          // #317 review, #349 (requirement 1): nothing previously read
          // result.warnings -- an instructor setting a temperature that
          // then got silently dropped (SUPPORTS_REASONING_EFFORT_NONE's own
          // doc comment) had no way to find out. Logged, not persisted -- a
          // best-effort operational signal, same tier as onError/onAbort
          // above, not a per-turn column this table needs.
          if (warnings && warnings.length > 0) {
            logServerError(
              "chatHandler.onFinish.warnings",
              new Error(
                `streamText warnings for conversation ${conv.id}, model ${resolvedLLMConfig.modelName}: ${JSON.stringify(warnings)}`,
              ),
            );
          }
          await finalizeAssistantTurn(db, conv.id, assistantMessage, {
            organizationId: orgScope,
            llmConfigId: resolvedLLMConfig.id,
            provider: resolvedLLMConfig.provider,
            model: resolvedLLMConfig.modelName,
            providerRequestId: response.id ?? null,
            inputTokens: usage.inputTokens ?? null,
            outputTokens: usage.outputTokens ?? null,
            costCents: estimateCostCents(
              resolvedLLMConfig.modelName,
              usage.inputTokens ?? null,
              usage.outputTokens ?? null,
              {
                input: resolvedLLMConfig.pricePerMillionInputTokens,
                output: resolvedLLMConfig.pricePerMillionOutputTokens,
              },
            ),
            latencyMs: Date.now() - turnStartedAt,
            errorFlag: isErrorOutcome || !shouldPersist,
          });
        } catch (err) {
          clearTimeout(timeoutHandle);
          // Best-effort, matching the release/persist/log steps this
          // replaces: a failure here must never surface as a second error
          // layered on the turn's own outcome. A conversation left locked
          // by this failing self-heals via LOCK_STALE_MS, same as any other
          // path that never reaches its own release call (see this
          // function's trade-off note in conversations.ts).
          //
          // #275: this used to be the ONE log statement on this whole route
          // that carried any turn-level identifying context at all -- and
          // even it carried none: `err` alone, no conversationId/userId/
          // model. An operator debugging "students say the tutor is weird"
          // couldn't even grep this one line down to a specific
          // conversation or model.
          logServerError("chatHandler.onFinish.finalizeAssistantTurn", err, {
            conversationId: conv.id,
            userId: authContext.session.userId,
            model: resolvedLLMConfig.modelName,
          });
        }
      },
    });
  } catch (err) {
    await releaseConversationTurnLock(db, conv.id).catch(() => {});
    throw err;
  }
}
