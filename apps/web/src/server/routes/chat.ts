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

   System prompt + model stay hardcoded, per #230: this is FLX-001's own
   filed scope, a duplicate of #25 (prompt assembly) and #26 (LLM config
   resolution), later tasks in this epic -- not in scope here.
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
import { getOpenRouter } from "../../lib/ai";
import { makeDb } from "../../db/client";
import type { ConversationKind } from "../../db/schema";
import {
  createConversation,
  appendMessage,
  getLastMessages,
  getOwnedConversationOrNull,
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
import { logServerError } from "../utils/errors";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";

const SYSTEM_PROMPT = `You are an AI tutor for an introductory statistics course at the University of Washington. Your job is to guide students through homework problems using the Socratic method: ask leading questions, build intuition step by step, never just dump the answer.

You have one structured rendering tool available: showDefinition. Call it whenever you are formally introducing a named statistical concept ("p-value", "null hypothesis", "standard error", "confidence interval", "type I error", etc.) — give the student a polished definition card with the term and a 1–2 sentence plain-language body. For everything else (guiding questions, follow-ups, gentle nudges, walking through computations), reply in plain markdown — no tool call.

Be warm, curious, and patient. Prefer questions over assertions.`;

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

// #215: bounds what the model sees on every turn. The client still sends
// its full local history (useChat's own state), but only the trailing
// window is forwarded to convertToModelMessages -- per-turn token cost is
// therefore bounded regardless of how long the conversation has run.
// Decision (documented per the issue's own request): a plain trailing
// window, dropped silently -- no rolling summary. A summarization strategy
// is real, separate work (tracked as #88, context-window management);
// until it lands, the oldest turns beyond this window are simply not seen
// by the model on a given turn, which is a graceful degradation (the
// student can still reference them in the visible UI transcript) rather
// than a hard failure.
const MAX_HISTORY_MESSAGES = 40;

export async function chatHandler(c: Context<AppEnv>) {
  const apiKey = c.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return c.json(
      {
        error:
          "OPENROUTER_API_KEY is not set. Add it to apps/web/.dev.vars for local dev or via `wrangler secret put OPENROUTER_API_KEY` for prod.",
      },
      500,
    );
  }

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

  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
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
  const {
    conversationId,
    courseId: requestedCourseId,
    sectionId: requestedSectionId,
    kind: requestedKind,
  } = envelopeParsed.data;
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
  // whole UIMessage[] history (it's what streamText needs for model
  // context, subject to the #215 trailing-window truncation below), but
  // only the LAST message -- the one just typed -- gets persisted per turn.
  // Everything before it either came from the DB on a "load conversation"
  // path (#4) or was already persisted on a prior turn.
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

  // #272: set only when THIS request just created a fresh section
  // conversation (the try branch below, not the race-fallback catch) --
  // prepended to the model's context further down so the turn that creates
  // a section conversation doesn't answer with zero knowledge of the
  // section's actual question text, which the greeting is the sole
  // delivery mechanism for. Left undefined on every other path (existing
  // conversationId, tutor kind, race fallback), which already has real
  // persisted history a normal turn would see.
  let sectionGreetingParts: unknown[] | undefined;

  let conv: { id: string; ownerUserId: string; courseId: string };
  if (conversationId) {
    // #217/#222: getOwnedConversationOrNull collapses "doesn't exist",
    // "exists but isn't yours", and "exists, is yours, but soft-deleted"
    // into the same null -> 404, matching routes/conversations.ts's
    // PATCH/DELETE/GET-messages handlers exactly (moved to the repository
    // layer, repositories/conversations.ts, precisely so this route could
    // reuse it instead of hand-rolling its own 404-vs-401 split, which was
    // the existence oracle this rule exists to avoid). Previously this
    // checked existence and ownership as two separate branches returning
    // 404 and 401 respectively; a caller could tell "doesn't exist" apart
    // from "exists, not yours" by response code, which the uniform-401
    // comment on the old code claimed not to be possible.
    const existing = await getOwnedConversationOrNull(
      db,
      conversationId,
      authContext.session.userId,
      authContext.isMemberOf,
    );
    if (!existing) {
      return c.json({ error: "Conversation not found" }, 404);
    }
    conv = existing;
  } else {
    // #304: previously fell back to authContext.memberships[0]?.courseId
    // when the client omitted courseId -- listMembershipsForUser has no
    // ORDER BY, so Postgres gives no ordering guarantee and [0] was
    // arbitrary, possibly differing between two requests from the same
    // user. ProfileService.ts already documents this exact pattern as a
    // hazard ("memberships[0] would make the primary role flicker across
    // requests") and deliberately avoids it; this PR reintroduced it on a
    // write path. A user with two memberships -- the norm for instructors
    // and TAs -- could get a tutor conversation silently minted into the
    // wrong course. Requiring courseId explicitly loses no real caller:
    // the section path already sends it on every no-conversationId
    // request (see handleSendMessage in App.tsx), and courseScopeFromAuthContext
    // below already rejects a course the caller isn't a member of, so
    // this doesn't relax that check either.
    if (!requestedCourseId) {
      return c.json({ error: "courseId is required when conversationId is omitted" }, 400);
    }
    const courseId = requestedCourseId;
    const scope = courseScopeFromAuthContext(authContext, courseId);
    if (!scope) {
      return c.json({ error: "Course access denied" }, 403);
    }
    // #214: kind defaults to "tutor" (every existing caller's behavior) --
    // only a caller that explicitly asks for "section" (App.tsx's
    // homework-section chat instance) needs a sectionId.
    //
    // #308/#267: an unrecognized kind used to silently coerce to "tutor"
    // instead of 400ing -- precisely the failure mode #214 itself was filed
    // for. chatEnvelopeSchema's z.enum(["section","tutor"]).optional()
    // above already rejects anything else (a typo, a future client's
    // not-yet-supported kind:"reflection") before this line is ever
    // reached, so requestedKind is only ever "section", "tutor", or
    // undefined here.
    const kind: ConversationKind = requestedKind === "section" ? "section" : "tutor";
    if (kind === "section") {
      if (!requestedSectionId) {
        return c.json({ error: "sectionId is required when kind is 'section'" }, 400);
      }
      // #259: routed through the same startSectionConversation every other
      // section-conversation caller uses (#27's own routes), not
      // createConversation -- which enforced none of isTeacherTest
      // derivation, non_interactive refusal, the duplicate-active-conversation
      // check, or the Django-parity greeting as the first message. This is
      // what makes #27's routes live (previously reachable from no client
      // code) instead of leaving two implementations of "start a section
      // conversation" to drift, which is what produced this bug in the
      // first place.
      try {
        const created = await startSectionConversation(db, scope, {
          sectionId: requestedSectionId,
          ownerUserId: authContext.session.userId,
          // #237: derived from the caller's actual course role, same rule
          // startSectionConversationHandler uses -- a TA or observer
          // sending into a section is not a student doing the assignment,
          // but is also not who isInstructorOf's AUTHOR_ROLES tier means.
          isTeacherTest: !isStudentInCourse(authContext.memberships, courseId),
        });
        conv = { id: created.id, ownerUserId: authContext.session.userId, courseId };
        sectionGreetingParts = Array.isArray(created.greetingParts) ? created.greetingParts : undefined;
      } catch (err) {
        if (err instanceof SectionConversationExistsError) {
          // #238-style race: two requests for the same section's first
          // turn (a double-fired send, two tabs) both arrived with no
          // conversationId yet. The loser doesn't get an error -- it uses
          // the conversation the winner just created, same as any other
          // retry lands on the same conversation.
          const active = await getActiveSectionConversation(
            db,
            scope,
            requestedSectionId,
            authContext.session.userId,
          );
          if (!active) throw err; // existence was just proven; a missing row here is a genuine bug, not a race
          conv = { id: active.id, ownerUserId: active.ownerUserId, courseId: active.courseId };
        } else if (err instanceof SectionNotFoundError) {
          return c.json({ error: "Section not found" }, 404);
        } else if (err instanceof SectionNotInteractiveError) {
          return c.json({ error: err.message }, 409);
        } else {
          throw err;
        }
      }
    } else {
      // #231: auto-title tutor conversations from their first message.
      const title = deriveTutorConversationTitle(inboundMessage.parts) || "New Conversation";
      conv = await createConversation(db, scope, {
        ownerUserId: authContext.session.userId,
        sectionId: null,
        kind: "tutor",
        title,
      });
    }
  }

  // Row just read back (and ownership-checked) or just created under a
  // verified scope -- the sanctioned case for this cast per scope.ts's
  // unsafeCourseScope docstring.
  const scope = unsafeCourseScope(conv.courseId);

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
  const [lastMessage, secondLastMessage] = await getLastMessages(db, scope, conv.id, 2);
  const matchesInboundUser = (msg: { role: string; clientMessageId: string | null } | undefined) =>
    msg?.role === "user" && msg.clientMessageId === parsedInbound.data.id;

  if (
    lastMessage?.role === "assistant" &&
    hasRenderableContent(lastMessage.parts) &&
    matchesInboundUser(secondLastMessage)
  ) {
    return replayResponse(conv.id, lastMessage.parts);
  }
  if (!matchesInboundUser(lastMessage)) {
    // #266: appendMessage's return value used to be discarded entirely, so
    // a reused clientMessageId with different content silently dropped the
    // new message while the call below still ran the model against it --
    // caught locally (not left to server/index.ts's global onError, though
    // that mapping stays as a safety net) so a well-formed conflict 409s
    // with the same request/response shape every other refusal on this
    // route already uses.
    try {
      const { created } = await appendMessage(db, scope, conv.id, {
        role: "user",
        parts: inboundMessage.parts,
        clientMessageId: parsedInbound.data.id,
      });
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
        const [raceLast, raceSecondLast] = await getLastMessages(db, scope, conv.id, 2);
        if (
          raceLast?.role === "assistant" &&
          hasRenderableContent(raceLast.parts) &&
          matchesInboundUser(raceSecondLast)
        ) {
          return replayResponse(conv.id, raceLast.parts);
        }
        return c.json(
          { error: "This message is already being processed. Please wait a moment." },
          409,
        );
      }
    } catch (err) {
      if (err instanceof IdempotencyKeyConflictError) {
        return c.json({ error: err.message }, 409);
      }
      throw err;
    }
  }

  const openrouter = getOpenRouter(apiKey);

  // #215: trailing window -- see MAX_HISTORY_MESSAGES' doc comment above
  // for the drop-silently decision.
  const windowedMessages =
    uiMessages.length > MAX_HISTORY_MESSAGES ? uiMessages.slice(-MAX_HISTORY_MESSAGES) : uiMessages;

  // #272: the client's own array (windowedMessages, built above) has no way
  // to know about a greeting the SERVER just wrote in startSectionConversation
  // above -- it only knows the message it just sent. Prepending it here is
  // what makes the model's very first answer in a section actually see the
  // question (section.content, embedded in the greeting), instead of
  // answering blind until a reload re-hydrates history that includes it.
  const modelContextMessages: UIMessage[] = sectionGreetingParts
    ? [
        { id: crypto.randomUUID(), role: "assistant", parts: sectionGreetingParts } as UIMessage,
        ...windowedMessages,
      ]
    : windowedMessages;

  const result = streamText({
    // Gemma 4 31B (instruction-tuned) on OpenRouter's free tier. Released
    // 2026-04-02, 262K context, native function calling (custom XML format
    // OpenRouter normalizes to the OpenAI-compatible tool call shape the AI
    // SDK expects). Free, with rate limits. #230: hardcoded pending #26
    // (LLM config resolution).
    model: openrouter("google/gemma-4-31b-it:free"),
    system: SYSTEM_PROMPT,
    messages: convertToModelMessages(modelContextMessages),
    // #264: belt-and-suspenders alongside historyMessageSchema's role
    // allowlist above -- the SDK warns and proceeds by default (its own
    // words: "a security risk because they may enable prompt injection
    // attacks"). This makes a role:"system" element a hard model-input
    // refusal even if some future change to that schema let one through.
    allowSystemInMessages: false,
    tools: TOOLS,
    /* Allow up to 5 steps so the model can call a display tool and then
       continue with the follow-up Socratic question in the same turn.
       Without this, streamText stops the moment a tool call is emitted. */
    stopWhen: stepCountIs(5),
  });

  return result.toUIMessageStreamResponse({
    headers: { "x-conversation-id": conv.id },
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
      if (isAborted || finishReason === "error") return;
      // A provider failure mid-stream (ai@5.0.195 delivers this as an
      // `error` chunk, not a rejection -- see hasRenderableContent's doc
      // comment) still lands here with a `responseMessage` that has no
      // real content. Persisting it anyway would write a permanently-empty
      // assistant row that the idempotency check above would then treat as
      // "already answered" on every future retry -- silently defeating the
      // client's retry affordance (#144) forever. Returning early instead
      // leaves nothing persisted for this turn, so a retry's idempotency
      // check falls through to a genuine model call again.
      if (!hasRenderableContent(responseMessage.parts)) return;
      try {
        await appendMessage(db, scope, conv.id, { role: "assistant", parts: responseMessage.parts });
      } catch (err) {
        logServerError("chatHandler.onFinish", err);
      }
    },
  });
}
