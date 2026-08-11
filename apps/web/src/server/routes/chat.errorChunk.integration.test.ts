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

/* In-memory stand-in for the two repository functions chatHandler's
   idempotency/persistence logic actually depends on -- faithful enough to
   exercise that REAL branching logic (routes/chat.ts is untouched by this
   mock) without a real Postgres. Rows carry an incrementing `createdAt` so
   getLastMessages' desc(createdAt) ordering is deterministic. */
interface FakeConversation { id: string; ownerUserId: string; courseId: string }
interface FakeMessageRow { id: string; conversationId: string; role: string; parts: unknown; createdAt: number }

let conversationsStore: Map<string, FakeConversation>;
let messagesStore: FakeMessageRow[];
let nextMessageId: number;
let nextCreatedAt: number;

vi.mock("../repositories/conversations", () => ({
  getConversationById: async (_db: unknown, id: string) => conversationsStore.get(id) ?? null,
  createConversation: async (
    _db: unknown,
    scope: string,
    input: { ownerUserId: string },
  ) => {
    const row: FakeConversation = { id: "conv-1", ownerUserId: input.ownerUserId, courseId: scope };
    conversationsStore.set(row.id, row);
    return row;
  },
  appendMessage: async (
    _db: unknown,
    _scope: string,
    conversationId: string,
    input: { role: "user" | "assistant" | "system"; parts: unknown },
  ) => {
    const row: FakeMessageRow = {
      id: `m${nextMessageId++}`,
      conversationId,
      role: input.role,
      parts: input.parts,
      createdAt: nextCreatedAt++,
    };
    messagesStore.push(row);
    return row;
  },
  getLastMessages: async (_db: unknown, _scope: string, conversationId: string, limit = 2) =>
    messagesStore
      .filter((m) => m.conversationId === conversationId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit),
}));

function fakeAuthContext(): AuthContext {
  const memberships = [{ id: "m1", userId: "u1", courseId: "course-a", role: "student" }] as AuthContext["memberships"];
  return {
    session: { userId: "u1", workosUserId: "w1", sessionEpoch: 0, issuedAt: 0, expiresAt: 0 },
    memberships,
    hasRole: (role) => memberships.some((m) => m.role === role),
    isMemberOf: (courseId) => memberships.some((m) => m.courseId === courseId),
    isInstructorOf: () => false,
  };
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

function postChat(app: Hono<AppEnv>, payload: { messages: unknown[]; conversationId?: string }) {
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

describe("POST /api/chat -- real error-chunk + real idempotency replay (PR-1 whole-branch review, Critical)", () => {
  beforeEach(() => {
    conversationsStore = new Map();
    messagesStore = [];
    nextMessageId = 1;
    nextCreatedAt = 1;
  });

  it("does not persist an assistant row when the model stream errors before producing any content", async () => {
    fakeModel = erroringModel();

    const res = await postChat(buildApp(), { messages: [userUiMessage] });
    // Per the AI SDK's own behavior, a stream-level `error` chunk does not
    // fail the HTTP response -- it's forwarded as an `error` UI chunk to the
    // client while the response itself still completes normally.
    expect(res.status).toBe(200);
    await res.text(); // drain the stream so onFinish has actually run

    const rows = messagesStore.filter((m) => m.conversationId === "conv-1");
    expect(rows.map((r) => r.role)).toEqual(["user"]); // no assistant row -- the turn stays retryable
  });

  it("calls the model again (not a replay) on an identical retry after an error-only turn, and this time persists the real reply", async () => {
    // First attempt: the model errors out with nothing produced.
    fakeModel = erroringModel();
    const app = buildApp();
    const firstRes = await postChat(app, { messages: [userUiMessage] });
    await firstRes.text();

    expect(messagesStore.map((m) => m.role)).toEqual(["user"]); // still just the user row

    // Retry: identical inbound user message, same conversation. If the
    // pre-fix idempotency check treated the (nonexistent, thanks to the
    // onFinish fix) empty assistant row as "already answered", this would
    // replay nothing and the model would never be called a second time.
    fakeModel = succeedingModel("recovered reply after retry");
    const secondRes = await postChat(app, {
      messages: [userUiMessage],
      conversationId: "conv-1",
    });
    expect(secondRes.status).toBe(200);
    const body = await secondRes.text();

    // A genuine second model call happened (not a replay of persisted
    // parts) -- the streamed body actually contains the new model's reply.
    expect(body).toContain("recovered reply after retry");

    const rows = messagesStore.filter((m) => m.conversationId === "conv-1");
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
    await (await postChat(app, { messages: [userUiMessage] })).text();

    fakeModel = succeedingModel("recovered reply");
    await (await postChat(app, { messages: [userUiMessage], conversationId: "conv-1" })).text();

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
    const thirdRes = await postChat(app, { messages: [userUiMessage], conversationId: "conv-1" });
    expect(thirdRes.status).toBe(200);
    const body = await thirdRes.text();
    expect(body).toContain("recovered reply");

    // Still exactly one assistant row -- the replay didn't write a new one.
    const assistantRows = messagesStore.filter((m) => m.conversationId === "conv-1" && m.role === "assistant");
    expect(assistantRows).toHaveLength(1);
  });
});
