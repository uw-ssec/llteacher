/* --------------------------------------------------------------------------
   Integration test for the PR-1 whole-branch-review Critical finding:

   In ai@5.0.195, a provider failure (e.g. a 429) arrives mid-stream as an
   `error` chunk, not a stream rejection -- the stream closes NORMALLY, so
   chat.ts's onFinish still fires. Before this fix, onFinish persisted
   whatever `responseMessage` it got unconditionally, so a turn that
   produced no real content still wrote an assistant row -- and
   chatHandler's idempotency "already answered" replay branch would then
   treat that row as a complete answer forever, silently defeating the
   #144 Retry button (every retry replays the same nothing instead of
   calling the model again).

   Unlike chat.test.ts (which mocks `streamText` itself, by design, to unit
   test chatHandler's own branching in isolation), THIS file does not mock
   `ai` at all -- it drives the real `streamText` / `toUIMessageStreamResponse`
   / `onFinish` pipeline against a hand-built fake `LanguageModelV2`
   standing in only for the network-calling model backend (not `ai/test`'s
   `MockLanguageModelV2`: that subpath transitively imports `msw`, which
   isn't installed in this repo -- the fake below satisfies the exact same
   `LanguageModelV2` interface `streamText` actually calls, so nothing
   AI-SDK-internal is any less real for it). Only `../../lib/ai`'s
   `getOpenRouter` (the OpenRouter provider factory) and the repository
   layer (an in-memory fake, not a real Postgres) are substituted --
   everything AI-SDK-internal in between (stream parsing, UI message chunk
   conversion, the onFinish state accumulator, the replay path's
   createUIMessageStream/createUIMessageStreamResponse) runs for real. This
   is the exact seam the review flagged as uncovered: neither #3's nor
   #144's own suite exercises the real error-chunk path together with the
   real idempotency/replay branch.
   -------------------------------------------------------------------------- */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { simulateReadableStream } from "ai";
import type { LanguageModelV2, LanguageModelV2StreamPart } from "@ai-sdk/provider";
import { chatHandler } from "./chat";
import type { AuthContext } from "../middleware/roles";
import { fakeAuthContext as buildFakeAuthContext, fakeMembership } from "../testing/authContext";
import type { AppEnv } from "../context";

const TEST_ENV = { DATABASE_URL: "ignored", OPENROUTER_API_KEY: "test-key" } as Env;

vi.mock("../../db/client", () => ({ makeDb: () => ({}) }));

/* Only the model-backend factory is faked -- streamText itself, and every
   AI-SDK stream-processing step downstream of doStream, is real. */
let fakeModel: LanguageModelV2;
vi.mock("../../lib/ai", () => ({
  getOpenRouter: () => () => fakeModel,
}));

// Minimal hand-built LanguageModelV2 -- doGenerate is never called by
// streamText (only doStream is), so it's stubbed to fail loudly if that
// assumption ever changes.
function fakeLanguageModel(chunks: LanguageModelV2StreamPart[]): LanguageModelV2 {
  return {
    specificationVersion: "v2",
    provider: "test-provider",
    modelId: "test-model",
    supportedUrls: {},
    async doGenerate() {
      throw new Error("doGenerate should not be called by streamText's streaming path");
    },
    async doStream() {
      return { stream: simulateReadableStream({ chunks }) };
    },
  };
}

/* In-memory stand-in for the repository functions chatHandler's
   idempotency/persistence logic actually depends on -- faithful enough to
   exercise that REAL branching logic (routes/chat.ts is untouched by this
   mock) without a real Postgres. Rows carry an incrementing `createdAt` so
   getLastMessages' desc(seq) ordering is deterministic. */
interface FakeConversation {
  id: string;
  ownerUserId: string;
  courseId: string;
  // #317 review, #322: mirrors conversations.processing_started_at so this
  // fake can model the per-conversation turn lock the same way the real
  // repository does -- this file's tests each drive one turn at a time
  // sequentially, so acquire always succeeds and release always no-ops,
  // but chat.ts calls both unconditionally and needs real functions here.
  processingStartedAt: number | null;
}
interface FakeMessageRow {
  id: string;
  conversationId: string;
  role: string;
  parts: unknown;
  clientMessageId: string | null;
  createdAt: number;
}

let conversationsStore: Map<string, FakeConversation>;
let messagesStore: FakeMessageRow[];
let nextMessageId: number;
let nextCreatedAt: number;

vi.mock("../repositories/conversations", () => ({
  getOwnedConversationOrNull: async (_db: unknown, id: string, userId: string) => {
    const conv = conversationsStore.get(id);
    return conv && conv.ownerUserId === userId ? conv : null;
  },
  createConversation: async (
    _db: unknown,
    scope: string,
    input: { ownerUserId: string },
  ) => {
    const row: FakeConversation = {
      id: "22222222-2222-2222-2222-222222222222",
      ownerUserId: input.ownerUserId,
      courseId: scope,
      processingStartedAt: null,
    };
    conversationsStore.set(row.id, row);
    return row;
  },
  // #317 review, #322: minimal fakes -- this file's own tests drive one
  // turn at a time, so acquire always succeeds (mirroring the real
  // conditional UPDATE's happy path) and release just clears the field.
  // The lock's actual concurrency guarantee is proven for real in
  // conversations.test.ts against a real Postgres, not re-proven here.
  acquireConversationTurnLock: async (_db: unknown, conversationId: string) => {
    const conv = conversationsStore.get(conversationId);
    if (conv) conv.processingStartedAt = Date.now();
    return true;
  },
  releaseConversationTurnLock: async (_db: unknown, conversationId: string) => {
    const conv = conversationsStore.get(conversationId);
    if (conv) conv.processingStartedAt = null;
  },
  appendMessage: async (
    _db: unknown,
    _scope: string,
    conversationId: string,
    input: { role: "user" | "assistant" | "system"; parts: unknown; clientMessageId?: string | null },
  ) => {
    const row: FakeMessageRow = {
      id: `m${nextMessageId++}`,
      conversationId,
      role: input.role,
      parts: input.parts,
      clientMessageId: input.clientMessageId ?? null,
      createdAt: nextCreatedAt++,
    };
    messagesStore.push(row);
    // #273: real appendMessage now returns { row, created } -- this fake
    // doesn't model onConflictDoNothing (nothing in this file's own tests
    // exercises the concurrent-duplicate path, that's chat.test.ts's and
    // conversations.test.ts's job), so it's always "created" here.
    return { row, created: true };
  },
  getLastMessages: async (_db: unknown, _scope: string, conversationId: string, limit = 2) =>
    messagesStore
      .filter((m) => m.conversationId === conversationId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit),
  // #317 review, #326: this file's own resolvePromptTemplate fake below
  // always returns id: null, so the write-back branch never actually fires
  // here -- a no-op fake, same defensive reasoning as the other
  // repositories/conversations fakes above (the module must export
  // SOMETHING chat.ts's import doesn't choke on).
  pinConversationPromptTemplate: async () => {},
  // #317 review, #346 (requirement 3): onFinish's release-lock/persist/log
  // steps collapsed into one call -- this fake models the two effects this
  // file's tests actually assert on (a real appendMessage-equivalent write
  // to messagesStore when assistantMessage is non-null; lock release always)
  // and no-ops the llm_call_logs write, same as the separate
  // recordLlmCallLog fake below used to.
  finalizeAssistantTurn: async (
    _db: unknown,
    conversationId: string,
    assistantMessage: { id: string; parts: unknown } | null,
  ) => {
    const conv = conversationsStore.get(conversationId);
    if (conv) conv.processingStartedAt = null;
    if (assistantMessage) {
      messagesStore.push({
        id: assistantMessage.id,
        conversationId,
        role: "assistant",
        parts: assistantMessage.parts,
        clientMessageId: null,
        createdAt: nextCreatedAt++,
      });
    }
  },
}));

// #219/#265: unmetered in this integration test -- rate limiting itself is
// covered directly in chat.test.ts (unit) and rateLimits.test.ts (real-DB
// concurrency). reserveRateLimitSlot now lives in its own module, so it
// needs its own mock here -- without one, chatHandler would call the real
// implementation against the mocked (`{}`) db above and throw.
vi.mock("../repositories/rateLimits", () => ({
  reserveRateLimitSlot: async () => 1,
  // #308: chat.ts now imports these as real values (not just the mocked
  // function) -- see chat.test.ts's identical mock for why.
  RATE_LIMIT_MAX_PER_MINUTE: 20,
  RATE_LIMIT_WINDOW_MS: 60_000,
}));

// #25: system-prompt resolution isn't what this suite exercises (it's about
// the error-chunk/idempotency seam) -- faked the same minimal way `lib/ai`
// is above, so chat.ts's new per-turn prompt-assembly calls don't reach the
// real Drizzle queries against the `{}` fake db. assembleSystemPrompt stays
// real (pure, no db) via importOriginal.
vi.mock("../repositories/organizations", () => ({
  getOrgScopeAndLlmConfigForCourse: async () => ({ orgScope: "org-a", courseLlmConfigId: null }),
}));
vi.mock("../../lib/prompts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/prompts")>();
  return {
    ...actual,
    getPinnedPromptTemplateContent: async () => null,
    resolvePromptTemplate: async () => ({ id: null, content: "test system prompt", version: null }),
    getSectionPromptContext: async () => null,
  };
});

// #26: same rationale -- resolveLLMConfig/resolveApiKey are faked so
// chat.ts's new per-turn config resolution doesn't reach the real Drizzle
// queries. buildProviderClient stays real (it just builds a client object,
// no network call), so the fake model factory below (../../lib/ai) is what
// actually intercepts the call.
vi.mock("../../lib/llm-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/llm-config")>();
  return {
    ...actual,
    resolveLLMConfig: async () => ({
      id: "llm-config-1",
      provider: "openrouter" as const,
      modelName: "test-model",
      temperature: 0.7,
      maxCompletionTokens: 1000,
      credentialId: null,
    }),
    resolveApiKey: async () => "sk-test-key",
  };
});

function fakeAuthContext(): AuthContext {
  return buildFakeAuthContext({
    memberships: [fakeMembership({ courseId: "55555555-5555-5555-5555-555555555555", role: "student" })],
  });
}

function buildApp() {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("authContext", fakeAuthContext());
    await next();
  });
  app.post("/api/chat", (c) => chatHandler(c));
  return app;
}

function postChat(app: Hono<AppEnv>, payload: { messages: unknown[]; conversationId?: string; courseId?: string }) {
  return app.request(
    "/api/chat",
    { method: "POST", body: JSON.stringify(payload), headers: { "content-type": "application/json" } },
    TEST_ENV,
  );
}

const userUiMessage = { id: "client-1", role: "user", parts: [{ type: "text", text: "hi there" }] };

// A provider failure mid-stream, per ai@5.0.195: the stream emits a
// `stream-start` and then an `error` part, with no text/tool content ever
// produced -- and then simply ENDS (no thrown rejection). This is exactly
// what a 429/5xx from OpenRouter looks like once the AI SDK's retry/error
// handling turns it into a stream-level error chunk instead of a rejected
// call.
function erroringModel(): LanguageModelV2 {
  return fakeLanguageModel([
    { type: "stream-start", warnings: [] },
    { type: "error", error: new Error("rate limited") },
  ]);
}

// #268: a provider failure AFTER some content already streamed -- the
// realistic shape of a mid-generation disconnect/upstream error, distinct
// from erroringModel's zero-content case above. Per ai@5.0.195, this still
// ends the stream normally (an `error` chunk, not a rejection), so onFinish
// still fires -- with a responseMessage whose text part carries
// state:"streaming" (never closed out by a text-end) and a finishReason of
// "error" on the callback's own event.
function partialThenErrorModel(): LanguageModelV2 {
  return fakeLanguageModel([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: "A p-value is the probability of" },
    { type: "error", error: new Error("upstream connection reset") },
  ]);
}

function succeedingModel(replyText: string): LanguageModelV2 {
  return fakeLanguageModel([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: replyText },
    { type: "text-end", id: "t1" },
    {
      type: "finish",
      finishReason: "stop",
      usage: { inputTokens: 3, outputTokens: 3, totalTokens: 6 },
    },
  ]);
}

// #342: a real client-side Stop or disconnect -- the reader on the
// response body is cancelled mid-stream, BEFORE any `finish` chunk is ever
// produced. Distinct from partialThenErrorModel above (a server-observed
// `error` chunk, finishReason "error"): a `reader.cancel()` never reaches
// the model backend as an error chunk at all -- per ai@5.0.195 (verified in
// #342's own issue text), this reaches onFinish through `cancel()`, not
// `flush()`, with `isAborted: false` and `finishReason: undefined`.
//
// Two steps, matching chatHandler's own `stopWhen: stepCountIs(5)` design
// (a tool call, then follow-up text in the same turn) and Cordero's exact
// #342 example: step 1 is a genuinely COMPLETE, resolved showDefinition
// tool call; step 2 is text cancelled mid-delta, never reaching text-end.
// This is the case the old `hasRenderableContent`'s `.some()` missed that
// a single-incomplete-part turn would NOT have: `.some()` finds the
// completed tool part and calls the whole array renderable, even though
// the text part sitting next to it never finished. `chunkDelayInMs` gives
// the test a real window to read step 2's partial text before cancelling.
function slowToolThenPartialTextModel(): LanguageModelV2 {
  let doStreamCallCount = 0;
  return {
    specificationVersion: "v2",
    provider: "test-provider",
    modelId: "test-model",
    supportedUrls: {},
    async doGenerate() {
      throw new Error("doGenerate should not be called by streamText's streaming path");
    },
    async doStream() {
      doStreamCallCount += 1;
      if (doStreamCallCount === 1) {
        // Step 1: a real showDefinition call, fully resolved -- the SDK
        // runs the app's own real `execute` and emits a tool-result before
        // this step's `finish`, so responseMessage.parts gets a genuine
        // `tool-showDefinition` part with state "output-available".
        return {
          stream: simulateReadableStream({
            chunkDelayInMs: 5,
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "tool-input-start", id: "call-1", toolName: "showDefinition" },
              { type: "tool-input-delta", id: "call-1", delta: '{"term":"p-value","body":"..."}' },
              { type: "tool-input-end", id: "call-1" },
              { type: "tool-call", toolCallId: "call-1", toolName: "showDefinition", input: '{"term":"p-value","body":"..."}' },
              { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 3, outputTokens: 3, totalTokens: 6 } },
            ] satisfies LanguageModelV2StreamPart[],
          }),
        };
      }
      // Step 2: follow-up text, cut short -- no text-end, no finish. A
      // real cancel() never lets the stream reach either.
      return {
        stream: simulateReadableStream({
          chunkDelayInMs: 20,
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "A p-value is " },
            { type: "text-delta", id: "t1", delta: "the probability of" },
            { type: "text-delta", id: "t1", delta: " seeing a result this extreme" },
            { type: "text-end", id: "t1" },
            { type: "finish", finishReason: "stop", usage: { inputTokens: 3, outputTokens: 3, totalTokens: 6 } },
          ] satisfies LanguageModelV2StreamPart[],
        }),
      };
    },
  };
}

describe("POST /api/chat -- real error-chunk + real idempotency replay (PR-1 whole-branch review, Critical)", () => {
  beforeEach(() => {
    conversationsStore = new Map();
    messagesStore = [];
    nextMessageId = 1;
    nextCreatedAt = 1;
  });

  it("does not persist an assistant row when the model stream errors before producing any content", async () => {
    fakeModel = erroringModel();

    const res = await postChat(buildApp(), { messages: [userUiMessage], courseId: "55555555-5555-5555-5555-555555555555" });
    // Per the AI SDK's own behavior, a stream-level `error` chunk does not
    // fail the HTTP response -- it's forwarded as an `error` UI chunk to the
    // client while the response itself still completes normally.
    expect(res.status).toBe(200);
    await res.text(); // drain the stream so onFinish has actually run

    const rows = messagesStore.filter((m) => m.conversationId === "22222222-2222-2222-2222-222222222222");
    expect(rows.map((r) => r.role)).toEqual(["user"]); // no assistant row -- the turn stays retryable
  });

  it("calls the model again (not a replay) on an identical retry after an error-only turn, and this time persists the real reply", async () => {
    // First attempt: the model errors out with nothing produced.
    fakeModel = erroringModel();
    const app = buildApp();
    const firstRes = await postChat(app, { messages: [userUiMessage], courseId: "55555555-5555-5555-5555-555555555555" });
    await firstRes.text();

    expect(messagesStore.map((m) => m.role)).toEqual(["user"]); // still just the user row

    // Retry: identical inbound user message, same conversation. If the
    // pre-fix idempotency check treated the (nonexistent, thanks to the
    // onFinish fix) empty assistant row as "already answered", this would
    // replay nothing and the model would never be called a second time.
    fakeModel = succeedingModel("recovered reply after retry");
    const secondRes = await postChat(app, {
      messages: [userUiMessage],
      conversationId: "22222222-2222-2222-2222-222222222222",
    });
    expect(secondRes.status).toBe(200);
    const body = await secondRes.text();

    // A genuine second model call happened (not a replay of persisted
    // parts) -- the streamed body actually contains the new model's reply.
    expect(body).toContain("recovered reply after retry");

    const rows = messagesStore.filter((m) => m.conversationId === "22222222-2222-2222-2222-222222222222");
    // Exactly one user row (never duplicated) and now one real assistant
    // row with actual content -- the turn is answered for good, not stuck
    // replaying emptiness on every future retry.
    expect(rows.filter((r) => r.role === "user")).toHaveLength(1);
    const assistantRows = rows.filter((r) => r.role === "assistant");
    expect(assistantRows).toHaveLength(1);
    expect(JSON.stringify(assistantRows[0]!.parts)).toContain("recovered reply after retry");
  });

  it("a THIRD identical request now replays the persisted (real) assistant reply instead of calling the model a third time", async () => {
    fakeModel = erroringModel();
    const app = buildApp();
    await (await postChat(app, { messages: [userUiMessage], courseId: "55555555-5555-5555-5555-555555555555" })).text();

    fakeModel = succeedingModel("recovered reply");
    await (await postChat(app, { messages: [userUiMessage], conversationId: "22222222-2222-2222-2222-222222222222" })).text();

    // Swap in a model that would throw if actually called -- proves this
    // third, identical request takes the replay branch, not a fresh call.
    fakeModel = {
      specificationVersion: "v2",
      provider: "test-provider",
      modelId: "test-model",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("model must not be called on a genuine replay");
      },
      async doStream() {
        throw new Error("model must not be called on a genuine replay");
      },
    };
    const thirdRes = await postChat(app, { messages: [userUiMessage], conversationId: "22222222-2222-2222-2222-222222222222" });
    expect(thirdRes.status).toBe(200);
    const body = await thirdRes.text();
    expect(body).toContain("recovered reply");

    // Still exactly one assistant row -- the replay didn't write a new one.
    const assistantRows = messagesStore.filter((m) => m.conversationId === "22222222-2222-2222-2222-222222222222" && m.role === "assistant");
    expect(assistantRows).toHaveLength(1);
  });

  describe("#268: partial content then a provider error mid-generation", () => {
    it("does not persist the partial text -- the half-sentence must not become a permanent 'answer'", async () => {
      fakeModel = partialThenErrorModel();

      const res = await postChat(buildApp(), { messages: [userUiMessage], courseId: "55555555-5555-5555-5555-555555555555" });
      expect(res.status).toBe(200);
      await res.text();

      const rows = messagesStore.filter((m) => m.conversationId === "22222222-2222-2222-2222-222222222222");
      // Pre-fix, this persisted {text:"A p-value is the probability of",
      // state:"streaming"} as a normal-looking assistant row.
      expect(rows.map((r) => r.role)).toEqual(["user"]);
    });

    it("calls the model again (not a replay of the half-sentence) on an identical retry, and this time persists the real reply", async () => {
      fakeModel = partialThenErrorModel();
      const app = buildApp();
      await (await postChat(app, { messages: [userUiMessage], courseId: "55555555-5555-5555-5555-555555555555" })).text();
      expect(messagesStore.map((m) => m.role)).toEqual(["user"]);

      fakeModel = succeedingModel("a p-value is the probability of seeing a result this extreme");
      const secondRes = await postChat(app, { messages: [userUiMessage], conversationId: "22222222-2222-2222-2222-222222222222" });
      const body = await secondRes.text();

      // The real, complete reply -- not the truncated fragment replayed
      // back with no error chunk, which is what the bug produced.
      expect(body).toContain("a p-value is the probability of seeing a result this extreme");
      expect(body).not.toMatch(/"state":"streaming"/);

      const rows = messagesStore.filter((m) => m.conversationId === "22222222-2222-2222-2222-222222222222");
      expect(rows.filter((r) => r.role === "user")).toHaveLength(1);
      expect(rows.filter((r) => r.role === "assistant")).toHaveLength(1);
    });
  });

  // #342: the case the pre-fix suite never drove -- every other test in
  // this file reaches onFinish by fully draining the response (`flush()`),
  // the same path a completed or provider-erroring turn takes. A client
  // Stop or disconnect reaches onFinish through `cancel()` instead, which
  // pre-fix looked exactly like success to the `isAborted ||
  // finishReason === "error"` check (both false/undefined on a plain
  // reader cancel) -- so the truncated text got persisted as a normal
  // answer, and a retry replayed the same fragment forever with no error
  // and no recovery short of Restart (which voids the submission).
  describe("#342: client Stop / disconnect mid-stream (real reader.cancel(), not flush())", () => {
    it("does not persist the truncated text when the reader is cancelled mid-stream", async () => {
      fakeModel = slowToolThenPartialTextModel();

      const res = await postChat(buildApp(), { messages: [userUiMessage], courseId: "55555555-5555-5555-5555-555555555555" });
      expect(res.status).toBe(200);
      expect(res.body).not.toBeNull();

      const reader = res.body!.getReader();
      // Read until at least one chunk of real text has come through, so
      // this is a genuine mid-answer cancel -- not one that races the
      // stream before it produces anything at all.
      let sawText = false;
      for (let i = 0; i < 20 && !sawText; i++) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && new TextDecoder().decode(value).includes("probability of")) sawText = true;
      }
      expect(sawText).toBe(true); // sanity: the test actually raced a real partial answer, not nothing

      // The Stop button's actual mechanism (App.tsx's stopChat, via
      // useChat -> AbortController -> the fetch reader) -- cancel before
      // the model's `finish` chunk (delayed 20ms per chunk) has a chance
      // to arrive.
      await reader.cancel();

      // onFinish's own work (lock release, the persistence gate, the
      // llm_call_logs write) is async and not awaited by reader.cancel()
      // itself -- poll briefly for it to settle rather than assuming a
      // fixed number of microtask ticks.
      const deadline = Date.now() + 2000;
      while (
        Date.now() < deadline &&
        conversationsStore.get("22222222-2222-2222-2222-222222222222")?.processingStartedAt !== null
      ) {
        await new Promise((r) => setTimeout(r, 10));
      }

      const rows = messagesStore.filter((m) => m.conversationId === "22222222-2222-2222-2222-222222222222");
      // Pre-fix, this persisted {text:"A p-value is the probability of...",
      // state:"streaming"} as a normal-looking, permanently-replayed answer.
      expect(rows.map((r) => r.role)).toEqual(["user"]);
    });

    it("calls the model again (not a replay of the cancelled fragment) on the next send", async () => {
      fakeModel = slowToolThenPartialTextModel();
      const app = buildApp();

      const res = await postChat(app, { messages: [userUiMessage], courseId: "55555555-5555-5555-5555-555555555555" });
      const reader = res.body!.getReader();
      for (let i = 0; i < 20; i++) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && new TextDecoder().decode(value).includes("probability of")) break;
      }
      await reader.cancel();

      const deadline = Date.now() + 2000;
      while (
        Date.now() < deadline &&
        conversationsStore.get("22222222-2222-2222-2222-222222222222")?.processingStartedAt !== null
      ) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(messagesStore.map((m) => m.role)).toEqual(["user"]);

      // A fresh send on the same conversation must reach the model again --
      // the classifyTurn idempotency check must not see the (nonexistent,
      // thanks to the fix) cancelled turn as "already answered".
      fakeModel = succeedingModel("a p-value is the probability of seeing a result this extreme");
      const secondRes = await postChat(app, {
        messages: [userUiMessage],
        conversationId: "22222222-2222-2222-2222-222222222222",
      });
      const body = await secondRes.text();
      expect(body).toContain("a p-value is the probability of seeing a result this extreme");

      const rows = messagesStore.filter((m) => m.conversationId === "22222222-2222-2222-2222-222222222222");
      expect(rows.filter((r) => r.role === "assistant")).toHaveLength(1);
    });
  });
});
