/* --------------------------------------------------------------------------
   POST /api/chat — Vercel AI SDK chat endpoint.

   Receives the client's UIMessage history, converts to model messages,
   calls OpenRouter via streamText with one display tool (showDefinition),
   and streams the response back in the UI message stream format that the
   client's useChat hook understands.

   The model can produce either:
     · plain markdown text   — rendered as paragraphs in the AI message
     · showDefinition tool   — rendered as a <DefinitionCard /> component

   This is the minimum-viable Generative UI loop. Adding more tools is a
   matter of: define the Zod schema here + ship a renderer in packages/ui.

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
import { courseScopeFromAuthContext, unsafeCourseScope } from "../repositories/scope";
import { IdempotencyKeyConflictError } from "../repositories/errors";
import { getOrgScopeForCourse } from "../repositories/organizations";
import { recordLlmCallLog } from "../repositories/llmCallLogs";
import { logServerError } from "../utils/errors";
import {
  assembleSystemPrompt,
  DEFAULT_SYSTEM_PROMPT,
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
const TOOLS: ToolSet = {
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
};

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
// handful at most) or how many messages the whole request could carry (the
// client sends its full local history every turn, #3 pitfall 3) -- both
// were `.min(1)` with no `.max()`, and `messages` itself was checked only
// for `length > 0`.
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
function hasRenderableContent(parts: unknown): boolean {
  if (!Array.isArray(parts)) return false;
  return parts.some((part) => {
    if (!part || typeof part !== "object" || !("type" in part)) return false;
    const type = (part as { type: unknown }).type;
    if (type === "text") {
      const text = (part as { text?: unknown }).text;
      if (typeof text !== "string" || text.length === 0) return false;
      // #268: a text part mid-generation carries state:"streaming" until
      // the SDK closes it out as state:"done" -- a part that never got
      // there (a provider error or a client disconnect mid-delta) is
      // exactly the truncated-answer case this whole function exists to
      // catch, and length>0 alone doesn't see it (verified empirically:
      // the persisted row from a text-then-error turn was
      // {text:"...", state:"streaming"}, which the old check accepted).
      // `state` is optional in the SDK's own type (older/synthetic parts
      // omit it) -- only an EXPLICIT "streaming" is rejected here, not its
      // absence, so replayPersistedPart's own always-complete text writes
      // (which never set state) keep working.
      const state = (part as { state?: unknown }).state;
      return state !== "streaming";
    }
    if (typeof type === "string" && type.startsWith("tool-")) {
      // #307: only a tool call that actually resolved -- output-available
      // (a real result) or output-error (a real, renderable failure) --
      // counts as content. input-available/input-streaming means the tool
      // was invoked but the turn ended (aborted, provider error) before it
      // resolved: replayPersistedPart has nothing to emit for that state
      // beyond a dangling tool-input-available, which is exactly the
      // "poisoned history" scenario (an unanswered tool call the model then
      // can't recover from on the next turn) this fix exists to stop from
      // ever being persisted as "answered" in the first place.
      const toolCallId = (part as { toolCallId?: unknown }).toolCallId;
      const state = (part as { state?: unknown }).state;
      return typeof toolCallId === "string" && (state === "output-available" || state === "output-error");
    }
    // step-start, reasoning, file, source-url/document, and anything else
    // this app's own TOOLS/renderer don't produce/display -- never counts.
    return false;
  });
}

// Replays an already-persisted assistant message's `parts` (jsonb, so typed
// unknown at the DB boundary) as UIMessageChunk writes -- used only by the
// "already answered" retry path below, never by a fresh model turn. Only
// handles the two part shapes this app's own TOOLS catalog can actually
// produce (plain text, and a completed showDefinition tool call/result) --
// anything else is dropped rather than guessed at, so an unrecognized part
// shape fails safe instead of throwing mid-replay.
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

// #317 review, #322: how old a held turn lock (conversations.processing
// started_at) must be before a new request is allowed to treat it as
// abandoned rather than genuinely in-flight. Comfortably above
// STREAM_TIMEOUT_MS -- a legitimate turn's lock must never go stale while
// that same turn could still be legitimately running -- to leave room for
// the persistence work on either side of the streamText call itself.
const LOCK_STALE_MS = 90_000;

// #312: the idempotency decision below used to live inline, TWICE -- once
// for the initial check, once for the race-fallback re-check after a lost
// appendMessage race (#273) -- with no way to unit-test either copy without
// going through the full HTTP handler and its seven module mocks. Extracted
// as a pure function (no db, no I/O) so both call sites share exactly one
// copy and chat.test.ts can assert the decision table directly, with zero
// mocks.
export type TurnClassification = "replay" | "skip-insert" | "insert";

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
 *  Response directly for every early-exit case (404/403/400/409) so
 *  chatHandler's own body stays a thin "resolve, then stream" dispatcher --
 *  callers must check `instanceof Response` before touching `.conv`. */
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
    }
  | Response
> {
  if (envelope.conversationId) {
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
      return c.json({ error: "Conversation not found" }, 404);
    }
    return { conv: existing, sectionGreetingParts: undefined };
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
    return c.json({ error: "Course access denied" }, 403);
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
        };
      }
      if (err instanceof SectionNotFoundError) {
        return c.json({ error: "Section not found" }, 404);
      }
      if (err instanceof SectionNotInteractiveError) {
        return c.json({ error: err.message }, 409);
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
  return { conv, sectionGreetingParts: undefined };
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
    return c.json({ error: "Unauthorized" }, 401);
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
    return c.json({ error: `Request body exceeds the ${MAX_REQUEST_BODY_BYTES} byte limit` }, 400);
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
    return c.json({ error: `messages must contain at most ${MAX_MESSAGES_PER_REQUEST} entries` }, 400);
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

  // Full history vs. incremental (#3 pitfall 3): the client still sends the
  // whole UIMessage[] history (useChat's own local state), but only the
  // LAST message -- the one just typed -- is trusted for anything. It gets
  // validated below and is the only part of `uiMessages` that gets
  // persisted or reaches the model; #143 stopped building the model's
  // context from the rest of this client-supplied array (see the
  // persistedHistory fetch further down) specifically because nothing
  // before the last entry is checked here.
  const inboundMessage = uiMessages[uiMessages.length - 1];
  const parsedInbound = inboundUserMessageSchema.safeParse(inboundMessage);
  if (!parsedInbound.success) {
    return c.json({ error: "The last message must be a user message with a non-empty parts array" }, 400);
  }

  const db = makeDb(c.env.DATABASE_URL);

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
      { error: "You're sending messages too quickly. Please wait a moment and try again." },
      429,
      { "Retry-After": String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)) },
    );
  }

  // #312: conversation resolution extracted to its own function -- see
  // resolveConversation's own doc comment. Early-exit cases (404/403/400/409)
  // come back as a Response to return directly.
  const resolved = await resolveConversation(c, db, authContext, envelopeParsed.data, inboundMessage);
  if (resolved instanceof Response) return resolved;
  const { conv, sectionGreetingParts } = resolved;

  // Row just read back (and ownership-checked) or just created under a
  // verified scope -- the sanctioned case for this cast per scope.ts's
  // unsafeCourseScope docstring.
  const scope = unsafeCourseScope(conv.courseId);
  // #25/#26: both prompt-template and LLM-config resolution need the org
  // scope for their own fallback queries -- resolved once and shared,
  // rather than each doing its own getOrgScopeForCourse round-trip.
  const orgScope = await getOrgScopeForCourse(db, scope);

  // #25: system prompt, resolved from the conversation's PINNED template
  // (set once at creation/restart -- see lib/prompts.ts's module doc
  // comment) rather than re-resolved here. A null promptTemplateId means
  // either a genuinely-unset scope (DEFAULT_SYSTEM_PROMPT was already the
  // right answer at creation) or a conversation that predates this column
  // -- both degrade the same way: resolve fresh now rather than fail the
  // turn over a missing pin.
  const systemPromptTemplateContent = conv.promptTemplateId
    ? await getPinnedPromptTemplateContent(db, conv.promptTemplateId)
    : null;
  const resolvedSystemPromptContent =
    systemPromptTemplateContent ??
    (orgScope ? (await resolvePromptTemplate(db, orgScope, scope, conv.sectionId)).content : DEFAULT_SYSTEM_PROMPT);
  const sectionPromptContext = conv.sectionId
    ? await getSectionPromptContext(db, scope, conv.sectionId)
    : null;
  // #317 review, blocking finding #4: an unreleased section (draft,
  // scheduled, or hidden/expired) must not leak its content into the model's
  // context, even for a conversation that started while it was live -- see
  // PromptSectionContext.isUnreleased's own doc comment. Collapses to the
  // same "Section not found" 404 startSectionConversation's own equivalent
  // gate (repositories/sectionConversations.ts) returns, so this stays
  // indistinguishable from a genuinely missing section, same rationale as
  // every sibling release gate in this codebase (#172 audit).
  if (sectionPromptContext?.isUnreleased && !authContext.canViewDraftsIn(conv.courseId)) {
    return c.json({ error: "Section not found" }, 404);
  }
  const systemPrompt = assembleSystemPrompt(resolvedSystemPromptContent, sectionPromptContext ?? undefined);

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
    return c.json({ error: "Something went wrong. Please try again later." }, 503);
  }
  let resolvedLLMConfig: Awaited<ReturnType<typeof resolveLLMConfig>>;
  try {
    resolvedLLMConfig = await resolveLLMConfig(db, orgScope, scope, sectionPromptContext?.homeworkId ?? null);
  } catch (err) {
    if (err instanceof LLMConfigNotFoundError) {
      logServerError("chatHandler.llmConfig", err);
      return c.json(
        { error: `I'm sorry, but there's no valid LLM configuration available right now. Reference ID: ${err.referenceId}` },
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
    providerClient = buildProviderClient(resolvedLLMConfig.provider, resolvedApiKey);
  } catch (err) {
    if (err instanceof LLMCredentialMissingError || err instanceof UnsupportedLLMProviderError) {
      const referenceId = crypto.randomUUID();
      logServerError("chatHandler.llmConfig", new Error(`${err.message} (ref: ${referenceId})`));
      return c.json(
        { error: `I'm sorry, but there's no valid LLM configuration available right now. Reference ID: ${referenceId}` },
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
    return c.json(
      {
        error: "Another message for this conversation is still being processed. Please wait a moment and try again.",
      },
      409,
    );
  }

  // #279: skipOwnershipCheck -- `conv` above already proved this
  // conversation is in scope (getOwnedConversationOrNull, or a row this
  // same request just created/raced onto inside resolveConversation), so
  // re-running the same id/courseId/isDeleted select here would be a
  // redundant round-trip.
  const [lastMessage, secondLastMessage] = await getLastMessages(db, scope, conv.id, 2, {
    skipOwnershipCheck: true,
  });
  const initialClassification = classifyTurn(lastMessage, secondLastMessage, parsedInbound.data.id);

  if (initialClassification === "replay") {
    // No model call is about to happen -- release immediately rather than
    // holding the lock until LOCK_STALE_MS expires for no reason.
    await releaseConversationTurnLock(db, conv.id);
    return replayResponse(conv.id, lastMessage!.parts);
  }
  if (initialClassification === "insert") {
    // #266: appendMessage's return value used to be discarded entirely, so
    // a reused clientMessageId with different content silently dropped the
    // new message while the call below still ran the model against it --
    // caught locally (not left to server/index.ts's global onError, though
    // that mapping stays as a safety net) so a well-formed conflict 409s
    // with the same request/response shape every other refusal on this
    // route already uses.
    try {
      const { created } = await appendMessage(
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
        // code.
        const [raceLast, raceSecondLast] = await getLastMessages(db, scope, conv.id, 2, {
          skipOwnershipCheck: true,
        });
        if (classifyTurn(raceLast, raceSecondLast, parsedInbound.data.id) === "replay") {
          await releaseConversationTurnLock(db, conv.id);
          return replayResponse(conv.id, raceLast!.parts);
        }
        await releaseConversationTurnLock(db, conv.id);
        return c.json(
          { error: "This message is already being processed. Please wait a moment." },
          409,
        );
      }
    } catch (err) {
      await releaseConversationTurnLock(db, conv.id);
      if (err instanceof IdempotencyKeyConflictError) {
        return c.json({ error: err.message }, 409);
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
    // Re-fetching from the row(s) this handler itself just confirmed or wrote
    // above closes that: everything the model sees is either a prior
    // assistant reply the server generated, or a prior user message this same
    // idempotency check already accepted. getLastMessages orders newest-first
    // (matches its use above); reversed here into the chronological order the
    // model needs. Same MAX_HISTORY_MESSAGES cap as before (#215), just
    // sourced server-side now instead of trusting the client's own window.
    const persistedHistory = await getLastMessages(db, scope, conv.id, MAX_HISTORY_MESSAGES, {
      skipOwnershipCheck: true,
    });
    const modelMessages: UIMessage[] = [...persistedHistory].reverse().map((m) => ({
      id: m.id,
      role: m.role as UIMessage["role"],
      parts: m.parts as UIMessage["parts"],
    }));

    // #272: getLastMessages above only knows what's already persisted -- a
    // freshly-created section conversation's greeting was just written inside
    // startSectionConversation's own atomic group, but that write can't be
    // relied on to be visible to this same request's read in every test/mock
    // configuration, so it's still passed through explicitly rather than
    // assumed to already be part of persistedHistory. Prepending it here is
    // what makes the model's very first answer in a section actually see the
    // question (section.content, embedded in the greeting), instead of
    // answering blind until a reload re-hydrates history that includes it.
    const modelContextMessages: UIMessage[] = sectionGreetingParts
      ? [
          { id: crypto.randomUUID(), role: "assistant", parts: sectionGreetingParts } as UIMessage,
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
      tools: TOOLS,
      temperature: resolvedLLMConfig.temperature,
      maxOutputTokens: resolvedLLMConfig.maxCompletionTokens,
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
        logServerError(
          "chatHandler.streamText.onError",
          new Error(
            `LLM call failed for conversation ${conv.id}, user ${authContext.session.userId}, provider ${resolvedLLMConfig.provider}, model ${resolvedLLMConfig.modelName}: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
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
      // #317 review, #321 + "strongly recommend" item: previously absent,
      // so the SDK's default error-to-string conversion reached the client
      // unfiltered -- combined with App.tsx rendering chatError.message
      // verbatim, a provider error (e.g. a raw 429 JSON body, "You're
      // sending messages too quickly...") reached the student exactly as
      // the provider phrased it. Logged for the same reason as streamText's
      // own onError above (this hook can fire for stream-processing errors
      // that one doesn't see), and replaced with a message that's actually
      // safe to show a student.
      onError: (error) => {
        logServerError(
          "chatHandler.toUIMessageStreamResponse.onError",
          error instanceof Error ? error : new Error(String(error)),
        );
        return "Something went wrong while generating a response. Please try again.";
      },
      // The AI SDK's natural hook for persisting the assistant turn --
      // responseMessage is the full final UIMessage (text parts + any
      // tool-call/tool-result parts), exactly the shape `messages.parts`
      // (jsonb) is meant to store; no manual text+toolCalls reconstruction
      // needed.
      //
      // #268: NOT persisted when isAborted or finishReason === "error" (a
      // client disconnect mid-delta, or a provider error after some content
      // already streamed) -- previously this refused only a fully-empty
      // response (hasRenderableContent's step-start-only case), which missed
      // the partial case entirely: a text-then-error turn persisted a
      // half-sentence as a normal-looking complete answer, and the
      // idempotency replay path above then served that same half-sentence on
      // every future retry, with no error chunk at all the second time. Two
      // signals said "incomplete" at this exact decision point and neither
      // was read: `finishReason`/`isAborted` on this callback's own event,
      // and the persisted text part's own `state: "streaming"` (now also
      // caught structurally by hasRenderableContent's strengthened text
      // branch, in case a future SDK stops surfacing finishReason). "length"
      // is deliberately NOT refused here -- that's a real, complete-as-far-
      // as-the-model-went answer (hit its token budget), not a truncation.
      //
      // best-effort, not double-write-proof: if the *worker process* dies
      // before onFinish runs (vs. the client just disconnecting), the
      // assistant message is lost and the client's retry will only re-send
      // the user message (already deduped above), so no response ever gets
      // generated for that turn. That gap is a documented limitation (#3
      // pitfall 2), not fixed here -- tracked as #96 (streaming resilience).
      onFinish: async ({ responseMessage, isAborted, finishReason }) => {
        // #317 review, #322: unconditional, before anything below -- the
        // turn is over (successfully, aborted, or errored) the moment
        // onFinish fires at all, so the lock must release here regardless
        // of which of those three this turn was. Best-effort
        // (releaseConversationTurnLock's own doc comment): a failure here
        // must never surface as a second error layered on the turn's own.
        await releaseConversationTurnLock(db, conv.id).catch((err) => {
          logServerError("chatHandler.onFinish.releaseLock", err);
        });

        // #268: NOT persisted when isAborted or finishReason === "error" (a
        // client disconnect mid-delta, or a provider error after some
        // content already streamed) -- previously this refused only a
        // fully-empty response (hasRenderableContent's step-start-only
        // case), which missed the partial case entirely: a text-then-error
        // turn persisted a half-sentence as a normal-looking complete
        // answer, and the idempotency replay path above then served that
        // same half-sentence on every future retry, with no error chunk at
        // all the second time. Two signals said "incomplete" at this exact
        // decision point and neither was read: `finishReason`/`isAborted`
        // on this callback's own event, and the persisted text part's own
        // `state: "streaming"` (now also caught structurally by
        // hasRenderableContent's strengthened text branch, in case a future
        // SDK stops surfacing finishReason). "length" is deliberately NOT
        // refused here -- that's a real, complete-as-far-as-the-model-went
        // answer (hit its token budget), not a truncation.
        //
        // A provider failure mid-stream (ai@5.0.195 delivers this as an
        // `error` chunk, not a rejection -- see hasRenderableContent's doc
        // comment) still lands here with a `responseMessage` that has no
        // real content. Persisting it anyway would write a permanently-empty
        // assistant row that the idempotency check above would then treat as
        // "already answered" on every future retry -- silently defeating the
        // client's retry affordance (#144) forever. Not persisting instead
        // leaves nothing for this turn, so a retry's idempotency check falls
        // through to a genuine model call again.
        //
        // best-effort, not double-write-proof: if the *worker process* dies
        // before onFinish runs (vs. the client just disconnecting), the
        // assistant message is lost and the client's retry will only re-send
        // the user message (already deduped above), so no response ever gets
        // generated for that turn. That gap is a documented limitation (#3
        // pitfall 2), not fixed here -- tracked as #96 (streaming resilience).
        const isErrorOutcome = isAborted || finishReason === "error";
        let persistedMessageId: string | null = null;
        if (!isErrorOutcome && hasRenderableContent(responseMessage.parts)) {
          try {
            const { row } = await appendMessage(
              db,
              scope,
              conv.id,
              { role: "assistant", parts: responseMessage.parts },
              { skipOwnershipCheck: true },
            );
            persistedMessageId = row.id;
          } catch (err) {
            logServerError("chatHandler.onFinish", err);
          }
        }

        // #317 review, #321: one llm_call_logs row per turn -- including the
        // error/aborted/no-content cases above, which previously early-
        // returned with nothing written anywhere. This was the operational
        // gap #321 names: a provider outage or a rotated key produced
        // "zero evidence" -- no error rate, no per-provider breakdown, no
        // latency, no cost. Best-effort like the release/persist steps
        // above: a logging failure must never surface as a second error
        // layered on this turn's own outcome.
        try {
          const [usage, response] = await Promise.all([result.usage, result.response]);
          await recordLlmCallLog(db, {
            messageId: persistedMessageId,
            conversationId: conv.id,
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
            ),
            latencyMs: Date.now() - turnStartedAt,
            errorFlag: isErrorOutcome || !persistedMessageId,
          });
        } catch (err) {
          logServerError("chatHandler.onFinish.recordLlmCallLog", err);
        }
      },
    });
  } catch (err) {
    await releaseConversationTurnLock(db, conv.id).catch(() => {});
    throw err;
  }
}
