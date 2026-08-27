/* --------------------------------------------------------------------------
   #364: provider failover, end to end through chatHandler.

   Invariant under test: when the primary provider fails before committing
   any content, the turn is served by the FALLBACK CONFIG'S OWN provider,
   under the FALLBACK CONFIG'S OWN credential, with the TURN'S generation
   parameters unchanged -- and it still produces exactly ONE llm_call_logs
   row, naming whoever actually served it.

   Why this file and not the unit suite. `llm/streamWithFallback.test.ts`
   proves the module picks the right attempt; that is necessary and not
   sufficient. The defect #364 exists to prevent -- "#363's version hardcoded
   openrouter() for both hops, so every failover would route through the
   wrong provider under the wrong credential" -- lives entirely in the WIRING
   between config resolution and the two streamText calls, which no unit test
   of either end can see. So this drives the real `streamText`,
   `toUIMessageStreamResponse` and `onFinish` against two hand-built
   `LanguageModelV2` doubles and asserts on what each of them was actually
   handed, which is the only place "the fallback used the primary's key"
   would be observable.

   Same fidelity posture as chat.errorChunk.integration.test.ts: `ai` is NOT
   mocked. Only the model backends, config resolution and the repository
   layer are substituted.
   -------------------------------------------------------------------------- */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { simulateReadableStream } from "ai";
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2StreamPart,
} from "@ai-sdk/provider";
import { chatHandler } from "./chat";
import type { AuthContext } from "../middleware/roles";
import { fakeAuthContext as buildFakeAuthContext, fakeMembership } from "../testing/authContext";
import type { AppEnv } from "../context";

const COURSE_ID = "55555555-5555-5555-5555-555555555555";
const TEST_ENV = { DATABASE_URL: "ignored", OPENROUTER_API_KEY: "sk-env" } as Env;

/* The two configs this suite resolves. Their generation parameters differ
   DELIBERATELY: the fallback's own temperature/maxCompletionTokens must not
   be the ones that reach the provider, because #364 requirement 4 is "a
   failover must not silently change generation parameters" -- the turn keeps
   the primary's. Their model families differ deliberately too, so the
   per-model `reasoningEffort` escape hatch is provably recomputed rather
   than copied. */
const PRIMARY_CONFIG = {
  id: "llm-config-primary",
  provider: "openrouter" as const,
  // Matches SUPPORTS_REASONING_EFFORT_NONE (gpt-5.1-5.4).
  modelName: "gpt-5.3-codex",
  temperature: 0.3,
  maxCompletionTokens: 777,
  credentialId: "cred-primary",
  fallbackLlmConfigId: "llm-config-fallback",
  basePrompt: "",
  pricePerMillionInputTokens: null,
  pricePerMillionOutputTokens: null,
  markCompleteInstruction: null,
};
const FALLBACK_CONFIG = {
  id: "llm-config-fallback",
  // A DIFFERENT provider from the primary -- the whole point of #364. Since
  // migration 0035 this is the realistic shape: llmoxie is every
  // organization's default, so a fallback that assumed openrouter would be
  // wrong for the common case, not an exotic one.
  provider: "llmoxie" as const,
  // Deliberately NOT in the gpt-5.1-5.4 family (so the reasoningEffort
  // escape hatch must NOT be copied onto it), and deliberately not a ":free"
  // model either -- estimateCostCents short-circuits those to 0, which would
  // hide whether the serving config's own rates were the ones consulted.
  modelName: "meta-llama/llama-4-70b-instruct",
  temperature: 0.95,
  maxCompletionTokens: 111,
  credentialId: "cred-fallback",
  fallbackLlmConfigId: null,
  basePrompt: "",
  pricePerMillionInputTokens: 2,
  pricePerMillionOutputTokens: 4,
  markCompleteInstruction: null,
};

vi.mock("../../db/client", () => ({ makeDb: () => ({}) }));

/* Config resolution is faked (it would otherwise run real Drizzle queries
   against the `{}` db above), but `buildProviderClient` is a SPY rather than
   a stub of convenience: what each hop asked for, and with which key, is
   precisely what this suite exists to assert. `resolveApiKey` derives its
   key from the config it is handed, so "the fallback used the primary's
   credential" is directly visible instead of having to be inferred. */
const resolveApiKeyMock = vi.fn(async (_env: unknown, _db: unknown, _scope: unknown, config: { id: string }) =>
  `key-for-${config.id}`,
);
const buildProviderClientMock = vi.fn();
const resolveFallbackLLMConfigMock = vi.fn();

vi.mock("../../lib/llm-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/llm-config")>();
  return {
    ...actual,
    resolveLLMConfig: async () => PRIMARY_CONFIG,
    resolveFallbackLLMConfig: (...a: unknown[]) => resolveFallbackLLMConfigMock(...a),
    resolveApiKey: (...a: unknown[]) => (resolveApiKeyMock as unknown as (...x: unknown[]) => unknown)(...a),
    buildProviderClient: (...a: unknown[]) => buildProviderClientMock(...a),
  };
});

vi.mock("../repositories/rateLimits", () => ({
  reserveRateLimitSlot: async () => 1,
  RATE_LIMIT_MAX_PER_MINUTE: 20,
  RATE_LIMIT_WINDOW_MS: 60_000,
}));
vi.mock("../repositories/organizations", () => ({
  getOrgScopeAndLlmConfigForCourse: async () => ({ orgScope: "org-a", courseLlmConfigId: null }),
}));
vi.mock("../../lib/prompts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/prompts")>()),
  getPinnedPromptTemplateContent: async () => null,
  resolvePromptTemplate: async () => ({ id: null, content: "test system prompt", version: null }),
  getSectionPromptContext: async () => null,
}));

/* The single llm_call_logs write the whole suite hinges on. Captured rather
   than no-op'd: "exactly one row, naming who served it" is a claim about
   this call's arity and arguments. */
const finalizeCalls: {
  assistantMessage: { id: string; parts: unknown } | null;
  llmLog: Record<string, unknown>;
}[] = [];

vi.mock("../repositories/conversations", () => ({
  getOwnedConversationOrNull: async () => null,
  createConversation: async (_db: unknown, scope: string, input: { ownerUserId: string }) => ({
    id: "22222222-2222-2222-2222-222222222222",
    ownerUserId: input.ownerUserId,
    courseId: scope,
    sectionId: null,
    promptTemplateId: null,
  }),
  acquireConversationTurnLock: async () => true,
  releaseConversationTurnLock: async () => {},
  appendMessage: async (
    _db: unknown,
    _scope: string,
    _conversationId: string,
    input: { role: string; parts: unknown; clientMessageId?: string | null },
  ) => ({ row: { id: "m1", role: input.role, parts: input.parts }, created: true }),
  getLastMessages: async () => [],
  pinConversationPromptTemplate: async () => {},
  finalizeAssistantTurn: async (
    _db: unknown,
    _conversationId: string,
    assistantMessage: { id: string; parts: unknown } | null,
    llmLog: Record<string, unknown>,
  ) => {
    finalizeCalls.push({ assistantMessage, llmLog });
  },
}));

/** Records the exact LanguageModelV2CallOptions it was invoked with -- the
 *  only place `temperature`/`maxOutputTokens`/`providerOptions` can be
 *  observed as they actually left the Worker, rather than as chat.ts
 *  intended them. */
interface RecordingModel {
  model: LanguageModelV2;
  calls: LanguageModelV2CallOptions[];
}
function recordingModel(modelId: string, chunks: LanguageModelV2StreamPart[]): RecordingModel {
  const calls: LanguageModelV2CallOptions[] = [];
  return {
    calls,
    model: {
      specificationVersion: "v2",
      provider: "test-provider",
      modelId,
      supportedUrls: {},
      async doGenerate() {
        throw new Error("doGenerate should not be called by streamText's streaming path");
      },
      async doStream(options: LanguageModelV2CallOptions) {
        calls.push(options);
        return { stream: simulateReadableStream({ chunks }) };
      },
    },
  };
}

/* A provider failure as ai@5.0.195 delivers one: an `error` part with no
   content ever produced, and then a normal stream end -- not a rejection.
   This is the recoverable window: not one byte reached the student. */
const FAILING_CHUNKS: LanguageModelV2StreamPart[] = [
  { type: "stream-start", warnings: [] },
  { type: "error", error: Object.assign(new Error("rate limited"), { statusCode: 429 }) },
];
const ANSWERING_CHUNKS: LanguageModelV2StreamPart[] = [
  { type: "stream-start", warnings: [] },
  { type: "response-metadata", id: "res-fallback" },
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: "the backup answered" },
  { type: "text-end", id: "t1" },
  {
    type: "finish",
    finishReason: "stop",
    usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 },
  },
];

let primaryModel: RecordingModel;
let fallbackModel: RecordingModel;

function fakeAuthContext(): AuthContext {
  return buildFakeAuthContext({
    memberships: [fakeMembership({ courseId: COURSE_ID, role: "student" })],
  });
}

/** Posts a turn AND drains the response body. Draining is load-bearing, not
 *  tidiness: `onFinish` -- where the llm_call_logs row is written -- runs in
 *  the stream's own flush, so a test that never reads the body would assert
 *  against a row that had not been written yet. */
async function postChat(): Promise<{ status: number; body: string }> {
  const res = await postChatRaw();
  const body = await res.text();
  // onFinish is awaited inside flush, but the finalize call it makes settles
  // on a later microtask than the last byte of the body.
  await new Promise((r) => setTimeout(r, 0));
  return { status: res.status, body };
}

function postChatRaw() {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("authContext", fakeAuthContext());
    await next();
  });
  app.post("/api/chat", (c) => chatHandler(c));
  return app.request(
    "/api/chat",
    {
      method: "POST",
      body: JSON.stringify({
        courseId: COURSE_ID,
        messages: [{ id: "client-1", role: "user", parts: [{ type: "text", text: "hi there" }] }],
      }),
      headers: { "content-type": "application/json" },
    },
    TEST_ENV,
  );
}

beforeEach(() => {
  finalizeCalls.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  primaryModel = recordingModel("gpt-5.3-codex", FAILING_CHUNKS);
  fallbackModel = recordingModel("meta-llama/llama-4-70b-instruct", ANSWERING_CHUNKS);
  resolveApiKeyMock.mockClear();
  resolveFallbackLLMConfigMock.mockReset().mockResolvedValue(FALLBACK_CONFIG);
  // Dispatches on the provider it is asked for, so a hop that asked for the
  // WRONG provider gets the wrong model and the assertions below fail loudly
  // rather than passing by coincidence.
  buildProviderClientMock.mockReset().mockImplementation((provider: string) => () =>
    provider === "llmoxie" ? fallbackModel.model : primaryModel.model,
  );
});

describe("chatHandler provider failover (#364)", () => {
  it("serves the turn from the fallback config's OWN provider and credential", async () => {
    const res = await postChat();
    expect(res.status).toBe(200);
    expect(res.body).toContain("the backup answered");

    // Two hops were built, and each asked for its own config's provider with
    // its own config's key. #363's version hardcoded openrouter for both,
    // which since migration 0035 is the wrong provider for the common case.
    expect(buildProviderClientMock).toHaveBeenCalledTimes(2);
    const [primaryCall, fallbackCall] = buildProviderClientMock.mock.calls;
    expect(primaryCall![0]).toBe("openrouter");
    expect(primaryCall![1]).toBe("key-for-llm-config-primary");
    expect(fallbackCall![0]).toBe("llmoxie");
    expect(fallbackCall![1]).toBe("key-for-llm-config-fallback");

    // The credential was resolved FROM THE FALLBACK'S OWN ROW -- its
    // credentialId, not the primary's, and not a fixed env binding.
    const keyedConfigs = resolveApiKeyMock.mock.calls.map((call) => call[3]);
    expect(keyedConfigs).toEqual([
      expect.objectContaining({ id: "llm-config-primary", credentialId: "cred-primary" }),
      expect.objectContaining({ id: "llm-config-fallback", credentialId: "cred-fallback" }),
    ]);

    // Both models were actually called: the primary failed, the fallback ran.
    expect(primaryModel.calls).toHaveLength(1);
    expect(fallbackModel.calls).toHaveLength(1);
  });

  it("carries the turn's generation parameters onto the fallback unchanged", async () => {
    await postChat();

    const primaryOptions = primaryModel.calls[0]!;
    const fallbackOptions = fallbackModel.calls[0]!;

    // #364 requirement 4. The fallback config's OWN row says 0.95/111; what
    // reached the provider is the turn's own 0.3/777. A failover swaps who
    // serves the turn, never how the answer is generated.
    expect(primaryOptions.temperature).toBe(0.3);
    expect(fallbackOptions.temperature).toBe(0.3);
    expect(primaryOptions.maxOutputTokens).toBe(777);
    expect(fallbackOptions.maxOutputTokens).toBe(777);

    // ...and the same system prompt and history, so the fallback answered
    // the same question.
    expect(fallbackOptions.prompt).toEqual(primaryOptions.prompt);

    // providerOptions IS recomputed per model, and that is what ENFORCES the
    // carried temperature rather than contradicting it: `reasoningEffort:
    // "none"` is the escape hatch that stops @ai-sdk/openai dropping
    // temperature, and it only exists for gpt-5.1-5.4. Copying the primary's
    // literal value onto a llama fallback would misroute an OpenAI-specific
    // parameter AND lose the temperature it was carrying.
    expect(primaryOptions.providerOptions).toEqual({ openai: { reasoningEffort: "none" } });
    expect(fallbackOptions.providerOptions).toBeUndefined();
  });

  it("writes exactly ONE llm_call_logs row, naming the model that served it", async () => {
    await postChat();

    // #364 requirement 3: one row per TURN, not one per attempt.
    expect(finalizeCalls).toHaveLength(1);
    const { llmLog } = finalizeCalls[0]!;
    expect(llmLog).toMatchObject({
      llmConfigId: "llm-config-fallback",
      provider: "llmoxie",
      model: "meta-llama/llama-4-70b-instruct",
      errorFlag: false,
    });
    // Not the primary, on any of the three fields that could name it.
    expect(llmLog.llmConfigId).not.toBe("llm-config-primary");
    expect(llmLog.provider).not.toBe("openrouter");
    expect(llmLog.model).not.toBe("gpt-5.3-codex");

    // Cost is estimated against the SERVING config's own per-1M rates
    // ($2 in + $4 out over 1M each = $6 = 600 cents), not the primary's
    // (which has none set at all, and would have produced null).
    expect(llmLog.costCents).toBe(600);

    // The assistant turn itself still persisted normally.
    expect(finalizeCalls[0]!.assistantMessage).not.toBeNull();
  });

  it("does not fail over when the config names no fallback", async () => {
    // The dominant configuration today, and the property that made wiring
    // this into a live chat path safe: it is the single streamText call it
    // replaced.
    resolveFallbackLLMConfigMock.mockResolvedValue(null);
    const res = await postChat();

    expect(res.status).toBe(200);
    expect(buildProviderClientMock).toHaveBeenCalledTimes(1);
    expect(fallbackModel.calls).toHaveLength(0);
    // The primary's failure still produces exactly one row, attributed to
    // the primary, with the error flagged -- today's behaviour untouched.
    expect(finalizeCalls).toHaveLength(1);
    expect(finalizeCalls[0]!.llmLog).toMatchObject({
      llmConfigId: "llm-config-primary",
      provider: "openrouter",
      errorFlag: true,
    });
  });

  it("does not fail over on a failure the fallback would share", async () => {
    // A 400 is a malformed request; the backup would reject it identically.
    primaryModel = recordingModel("gpt-5.3-codex", [
      { type: "stream-start", warnings: [] },
      { type: "error", error: Object.assign(new Error("bad request"), { statusCode: 400 }) },
    ]);
    await postChat();

    expect(fallbackModel.calls).toHaveLength(0);
    expect(finalizeCalls).toHaveLength(1);
    expect(finalizeCalls[0]!.llmLog).toMatchObject({ llmConfigId: "llm-config-primary" });
  });

  it("does not fail over once the primary has committed content", async () => {
    // The boundary: a mid-stream failure after text has reached the student
    // keeps today's behaviour exactly. Re-running on the fallback would
    // duplicate what they already read.
    primaryModel = recordingModel("gpt-5.3-codex", [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "half an answer" },
      { type: "error", error: Object.assign(new Error("rate limited"), { statusCode: 429 }) },
    ]);
    const res = await postChat();

    expect(res.body).toContain("half an answer");
    expect(fallbackModel.calls).toHaveLength(0);
    expect(finalizeCalls[0]!.llmLog).toMatchObject({ llmConfigId: "llm-config-primary" });
  });

  it("still serves the primary's whole answer after the probe peeks at it", async () => {
    // The probe reads its own `.tee()` branch and cancels it; the branch
    // toUIMessageStreamResponse takes must still carry every chunk. If this
    // ever regresses, students lose the first token of every reply.
    primaryModel = recordingModel("gpt-5.3-codex", ANSWERING_CHUNKS);
    const res = await postChat();

    expect(res.body).toContain("the backup answered");
    expect(fallbackModel.calls).toHaveLength(0);
    expect(finalizeCalls[0]!.llmLog).toMatchObject({
      llmConfigId: "llm-config-primary",
      errorFlag: false,
    });
  });
});
