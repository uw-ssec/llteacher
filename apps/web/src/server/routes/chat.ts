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
     1. resolve/create the conversation (conversationId from the client, or a
        brand-new "tutor" conversation if absent)
     2. persist the inbound user message (idempotently -- see the retry
        comment below) before calling the model
     3. stream the response, persisting the full final UIMessage (text + any
        tool parts) via toUIMessageStreamResponse's onFinish hook
     4. return the conversationId to the client via the x-conversation-id
        response header, so it can send it back on the next turn
   System prompt + model stay hardcoded (unchanged from before #3) --
   prompt assembly (#25) and LLM config resolution (#26) are later tasks in
   this epic, not in scope here.
   -------------------------------------------------------------------------- */

import type { Context } from "hono";
import {
  streamText,
  convertToModelMessages,
  jsonSchema,
  stepCountIs,
  type UIMessage,
  type ToolSet,
} from "ai";
import { z } from "zod";
import { getOpenRouter } from "../../lib/ai";
import { makeDb } from "../../db/client";
import {
  getConversationById,
  createConversation,
  appendMessage,
  getLastMessage,
} from "../repositories/conversations";
import { courseScopeFromAuthContext, unsafeCourseScope } from "../repositories/scope";
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
}

// Validates only the shape chatHandler actually depends on (role, and parts
// being a non-empty array of `{ type, ... }` objects) -- not the full AI SDK
// UIMessage schema. A buggy or malicious client sending a malformed parts
// array must 400 here rather than reach appendMessage's jsonb insert, which
// would happily store whatever it's given (#3 pitfall 4).
const chatPartSchema = z.object({ type: z.string() }).passthrough();
const inboundUserMessageSchema = z.object({
  role: z.literal("user"),
  parts: z.array(chatPartSchema).min(1),
});

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

  let body: ChatRequestBody;
  try {
    body = await c.req.json<ChatRequestBody>();
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }
  const { messages: uiMessages, conversationId, courseId: requestedCourseId } = body;
  if (!Array.isArray(uiMessages) || uiMessages.length === 0) {
    return c.json({ error: "messages is required" }, 400);
  }

  // Full history vs. incremental (#3 pitfall 3): the client still sends the
  // whole UIMessage[] history (it's what streamText needs for model
  // context), but only the LAST message -- the one just typed -- gets
  // persisted per turn. Everything before it either came from the DB on a
  // future "load conversation" path (not built yet, #27) or was already
  // persisted on a prior turn.
  const inboundMessage = uiMessages[uiMessages.length - 1];
  const parsedInbound = inboundUserMessageSchema.safeParse(inboundMessage);
  if (!parsedInbound.success) {
    return c.json({ error: "The last message must be a user message with a non-empty parts array" }, 400);
  }

  const db = makeDb(c.env.DATABASE_URL);

  let conv: { id: string; ownerUserId: string; courseId: string };
  if (conversationId) {
    const existing = await getConversationById(db, conversationId);
    if (!existing) {
      return c.json({ error: "Conversation not found" }, 404);
    }
    // Ownership check (#3): a conversationId the client supplies is an
    // unvalidated UUID -- proven to belong to the requester only by this
    // comparison, never by trusting the client's say-so. Uniform 401
    // (matches submitSectionHandler's uniform 403 for the analogous check)
    // rather than a 404-vs-401 split, so a guessed conversationId can't be
    // used to confirm one exists that isn't the caller's.
    if (existing.ownerUserId !== authContext.session.userId) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    conv = existing;
  } else {
    const fallbackCourseId = requestedCourseId ?? authContext.memberships[0]?.courseId;
    const scope = fallbackCourseId ? courseScopeFromAuthContext(authContext, fallbackCourseId) : null;
    if (!scope) {
      return c.json({ error: "Course access denied" }, 403);
    }
    conv = await createConversation(db, scope, {
      ownerUserId: authContext.session.userId,
      sectionId: null,
      kind: "tutor",
      title: "New Conversation",
    });
  }

  // Row just read back (and ownership-checked) or just created under a
  // verified scope -- the sanctioned case for this cast per scope.ts's
  // unsafeCourseScope docstring.
  const scope = unsafeCourseScope(conv.courseId);

  // Idempotency (#3): if the last message already persisted to this
  // conversation is this exact user message, this is a client retry after a
  // disconnect (the user message landed, the response never got back to the
  // client) rather than a genuinely new turn -- skip the insert so retrying
  // doesn't duplicate the row.
  const lastMessage = await getLastMessage(db, scope, conv.id);
  const isRetryOfLastMessage =
    lastMessage?.role === "user" &&
    JSON.stringify(lastMessage.parts) === JSON.stringify(parsedInbound.data.parts);
  if (!isRetryOfLastMessage) {
    await appendMessage(db, scope, conv.id, { role: "user", parts: inboundMessage.parts });
  }

  const openrouter = getOpenRouter(apiKey);

  const result = streamText({
    /* Gemma 4 31B (instruction-tuned) on OpenRouter's free tier.
       Released 2026-04-02, 262K context, native function calling (custom
       XML format that OpenRouter normalizes to the OpenAI-compatible tool
       call shape the AI SDK expects). Strong on reasoning + Socratic-style
       instruction following per Google's docs. Free, with rate limits. */
    model: openrouter("google/gemma-4-31b-it:free"),
    system: SYSTEM_PROMPT,
    messages: convertToModelMessages(uiMessages),
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
    // needed. Persisted even when isAborted (a cancelled/dropped stream
    // still gets whatever partial content it produced saved, rather than
    // losing the turn outright) -- best-effort, not double-write-proof: if
    // the *worker process* dies before onFinish runs (vs. the client just
    // disconnecting), the assistant message is lost and the client's retry
    // will only re-send the user message (already deduped above), so no
    // response ever gets generated for that turn. That gap is a documented
    // limitation (#3 pitfall 2), not fixed here -- would need a
    // status/resume endpoint, out of scope for this task.
    onFinish: async ({ responseMessage }) => {
      try {
        await appendMessage(db, scope, conv.id, { role: "assistant", parts: responseMessage.parts });
      } catch (err) {
        logServerError("chatHandler.onFinish", err);
      }
    },
  });
}
