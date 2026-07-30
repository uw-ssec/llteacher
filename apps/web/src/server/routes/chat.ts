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
import { getOpenRouter } from "../../lib/ai";

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

export async function chatHandler(c: Context<{ Bindings: Env }>) {
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

  const { messages } = await c.req.json<{ messages: UIMessage[] }>();

  const openrouter = getOpenRouter(apiKey);

  const result = streamText({
    /* Gemma 4 31B (instruction-tuned) on OpenRouter's free tier.
       Released 2026-04-02, 262K context, native function calling (custom
       XML format that OpenRouter normalizes to the OpenAI-compatible tool
       call shape the AI SDK expects). Strong on reasoning + Socratic-style
       instruction following per Google's docs. Free, with rate limits. */
    model: openrouter("google/gemma-4-31b-it:free"),
    system: SYSTEM_PROMPT,
    messages: convertToModelMessages(messages),
    tools: TOOLS,
    /* Allow up to 5 steps so the model can call a display tool and then
       continue with the follow-up Socratic question in the same turn.
       Without this, streamText stops the moment a tool call is emitted. */
    stopWhen: stepCountIs(5),
  });

  return result.toUIMessageStreamResponse();
}
