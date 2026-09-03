/* --------------------------------------------------------------------------
   #31 / #170: the LLM configuration routes.

   The repository suite (repositories/llmConfigs.test.ts) owns the data
   invariants against a real Postgres. This file owns the request contract:
   who is admitted, which bodies are refused and with what sentence, what the
   test button does and does not disclose, and what reaches the audit log.
   -------------------------------------------------------------------------- */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  cloneLlmConfigHandler,
  createLlmConfigHandler,
  deactivateLlmConfigHandler,
  getLlmConfigHandler,
  listLlmConfigsHandler,
  testLlmConfigHandler,
  updateLlmConfigHandler,
} from "./llmConfigs";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import { fakeAuthContext, fakeMembership } from "../testing/authContext";
import { LLMCredentialMissingError, UnsupportedLLMProviderError } from "../../lib/llm-config";

const TEST_ENV = { DATABASE_URL: "ignored", OPENROUTER_API_KEY: "sk-test" } as Env;
const CONFIG_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_ID = "11111111-2222-4333-8444-555555555556";

const CONFIG = {
  id: CONFIG_ID,
  recordNumber: 1,
  name: "Socratic",
  provider: "openrouter" as const,
  modelName: "google/gemma-4-31b-it:free",
  basePrompt: "You are a tutor.",
  temperature: 0.7,
  maxCompletionTokens: 1000,
  fallbackLlmConfigId: null,
  isDefault: true,
  isActive: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

/** #365: what `loadLLMConfigById` (lib/llm-config.ts) returns for the same
 *  row -- the test button reads through that loader now, not the console's
 *  own `getLlmConfig` projection, because it needs `credentialId` to resolve
 *  a key for the config's actual provider. Deliberately NOT the
 *  admin-console record shape.
 *
 *  #390/merge note: this ONE row is everything the handler uses -- provider
 *  and credentialId for the client, modelName/basePrompt/temperature/
 *  maxCompletionTokens for the generation -- which is why no test here mocks
 *  a second per-request config read.
 *
 *  Mirrors CONFIG's provider so the record and the resolved row describe the
 *  same config; both provider branches (openrouter, llmoxie -- every org's
 *  default after migration 0035, and the case the old hardcoded-OpenRouter
 *  code got wrong) get their own explicit test below. */
const RESOLVED_CONFIG = {
  id: CONFIG_ID,
  provider: CONFIG.provider as "openrouter" | "llmoxie",
  modelName: CONFIG.modelName,
  temperature: CONFIG.temperature,
  maxCompletionTokens: CONFIG.maxCompletionTokens,
  credentialId: null,
  fallbackLlmConfigId: null,
  basePrompt: CONFIG.basePrompt,
  pricePerMillionInputTokens: null,
  pricePerMillionOutputTokens: null,
  markCompleteInstruction: null,
};

const listMock = vi.fn();
const getMock = vi.fn();
const createMock = vi.fn();
const updateMock = vi.fn();
const deactivateMock = vi.fn();
const cloneMock = vi.fn();
const getOrgScopeForCourseMock = vi.fn();
const auditBestEffortMock = vi.fn();
const generateTextMock = vi.fn();
const loadLlmConfigByIdMock = vi.fn();
const resolveApiKeyMock = vi.fn();
const buildProviderClientMock = vi.fn();

vi.mock("../repositories/llmConfigs", () => ({
  listLlmConfigsForOrg: (...a: unknown[]) => listMock(...a),
  getLlmConfig: (...a: unknown[]) => getMock(...a),
  createLlmConfig: (...a: unknown[]) => createMock(...a),
  updateLlmConfig: (...a: unknown[]) => updateMock(...a),
  deactivateLlmConfig: (...a: unknown[]) => deactivateMock(...a),
  cloneLlmConfig: (...a: unknown[]) => cloneMock(...a),
}));
vi.mock("../repositories/organizations", () => ({
  getOrgScopeForCourse: (...a: unknown[]) => getOrgScopeForCourseMock(...a),
}));
vi.mock("../utils/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/audit")>()),
  auditBestEffort: (...a: unknown[]) => auditBestEffortMock(...a),
}));
vi.mock("../../db/client", () => ({ makeDb: () => ({}) }));
vi.mock("ai", () => ({ generateText: (...a: unknown[]) => generateTextMock(...a) }));
/* #365: the handler no longer reaches for getOpenRouter directly -- it
   resolves a provider client the same way the chat path does. These mocks
   record WHICH provider and key it resolved with, which is the whole point
   of the fix: the old code produced a plausible-looking result while
   talking to the wrong provider. `importOriginal` keeps every other export
   real so nothing else in this module is silently stubbed out -- in
   particular the error classes, so the handler's `instanceof` branches are
   exercised rather than stubbed. */
vi.mock("../../lib/llm-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/llm-config")>()),
  loadLLMConfigById: (...a: unknown[]) => loadLlmConfigByIdMock(...a),
  resolveApiKey: (...a: unknown[]) => resolveApiKeyMock(...a),
  buildProviderClient: (...a: unknown[]) => buildProviderClientMock(...a),
}));

function buildApp(authContext: AuthContext | undefined) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    if (authContext) c.set("authContext", authContext);
    await next();
  });
  const base = "/api/courses/:courseId/llm-configs";
  app.get(base, (c) => listLlmConfigsHandler(c));
  app.post(base, (c) => createLlmConfigHandler(c));
  app.get(`${base}/:configId`, (c) => getLlmConfigHandler(c));
  app.patch(`${base}/:configId`, (c) => updateLlmConfigHandler(c));
  app.delete(`${base}/:configId`, (c) => deactivateLlmConfigHandler(c));
  app.post(`${base}/:configId/clone`, (c) => cloneLlmConfigHandler(c));
  app.post(`${base}/:configId/test`, (c) => testLlmConfigHandler(c));
  return app;
}

const instructorOfA = () =>
  fakeAuthContext({ memberships: [fakeMembership({ courseId: "course-a", role: "instructor" })] });
const taOfA = () =>
  fakeAuthContext({ memberships: [fakeMembership({ courseId: "course-a", role: "ta" })] });

const url = (suffix = "") => `/api/courses/course-a/llm-configs${suffix}`;
const json = (method: string, body: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const VALID_BODY = {
  name: "Socratic",
  provider: "openrouter",
  modelName: "google/gemma-4-31b-it:free",
  basePrompt: "You are a tutor.",
  temperature: 0.7,
  maxCompletionTokens: 1000,
  fallbackLlmConfigId: null,
  isActive: true,
  isDefault: false,
};

beforeEach(() => {
  listMock.mockReset().mockResolvedValue([CONFIG]);
  getMock.mockReset().mockResolvedValue(CONFIG);
  createMock.mockReset().mockResolvedValue(CONFIG);
  updateMock.mockReset().mockResolvedValue(CONFIG);
  deactivateMock.mockReset().mockResolvedValue("deactivated");
  cloneMock.mockReset().mockResolvedValue({ ...CONFIG, id: OTHER_ID, isDefault: false });
  getOrgScopeForCourseMock.mockReset().mockResolvedValue("org-1");
  auditBestEffortMock.mockReset().mockResolvedValue(undefined);
  generateTextMock
    .mockReset()
    .mockResolvedValue({ text: "Hello.", usage: { inputTokens: 12, outputTokens: 3 } });
  loadLlmConfigByIdMock.mockReset().mockResolvedValue(RESOLVED_CONFIG);
  resolveApiKeyMock.mockReset().mockResolvedValue("sk-resolved");
  buildProviderClientMock
    .mockReset()
    .mockImplementation((provider: string, apiKey: string) => (model: string) => ({
      provider,
      apiKey,
      model,
    }));
});

describe("LLM config authorization (#31)", () => {
  /** A TA is a grader, not an author. Repointing the organization at a
   *  different model is authoring authority of the widest kind -- it changes
   *  what every student in every course talks to. */
  const cases: [string, RequestInit | undefined, string][] = [
    ["GET list", undefined, url()],
    ["POST create", json("POST", VALID_BODY), url()],
    ["GET detail", undefined, url(`/${CONFIG_ID}`)],
    ["PATCH update", json("PATCH", VALID_BODY), url(`/${CONFIG_ID}`)],
    ["DELETE deactivate", { method: "DELETE" }, url(`/${CONFIG_ID}`)],
    ["POST clone", json("POST", { name: "Copy" }), url(`/${CONFIG_ID}/clone`)],
    ["POST test", json("POST", { message: "hi" }), url(`/${CONFIG_ID}/test`)],
  ];

  for (const [label, init, path] of cases) {
    it(`denies a TA on ${label}`, async () => {
      const res = await buildApp(taOfA()).request(path, init, TEST_ENV);
      expect(res.status).toBe(403);
    });

    it(`denies an instructor of another course on ${label}`, async () => {
      const other = fakeAuthContext({
        memberships: [fakeMembership({ courseId: "course-z", role: "instructor" })],
      });
      expect((await buildApp(other).request(path, init, TEST_ENV)).status).toBe(403);
    });
  }

  it("403s when the course resolves to no organization", async () => {
    // Fails closed: an unresolvable org must not become an unscoped query.
    getOrgScopeForCourseMock.mockResolvedValue(null);
    expect((await buildApp(instructorOfA()).request(url(), undefined, TEST_ENV)).status).toBe(403);
    expect(listMock).not.toHaveBeenCalled();
  });
});

describe("POST/PATCH validation (#31)", () => {
  const post = (body: unknown) =>
    buildApp(instructorOfA()).request(url(), json("POST", body), TEST_ENV);

  const bad: [string, Record<string, unknown>][] = [
    ["a blank name", { name: "   " }],
    ["an unknown provider", { provider: "hal9000" }],
    ["a blank model id", { modelName: "" }],
    ["temperature above 2", { temperature: 2.1 }],
    ["temperature below 0", { temperature: -0.1 }],
    ["a fractional token budget", { maxCompletionTokens: 100.5 }],
    ["a token budget below the floor", { maxCompletionTokens: 1 }],
    ["a token budget above the ceiling", { maxCompletionTokens: 999999 }],
    ["a non-boolean isActive", { isActive: "on" }],
    ["a non-boolean isDefault", { isDefault: "" }],
    ["a non-uuid fallback", { fallbackLlmConfigId: "not-a-uuid" }],
  ];

  for (const [label, override] of bad) {
    it(`rejects ${label} with a 400 and no write`, async () => {
      const res = await post({ ...VALID_BODY, ...override });
      expect(res.status).toBe(400);
      expect(createMock).not.toHaveBeenCalled();
    });
  }

  it("rejects a non-finite temperature", async () => {
    // JSON admits 1e999, which parses to Infinity, passes a naive
    // `>= 0 && <= 2` for the wrong reason, and reaches a double column.
    const res = await buildApp(instructorOfA()).request(
      url(),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"name":"x","provider":"openrouter","modelName":"m","basePrompt":"","temperature":1e999,"maxCompletionTokens":1000,"fallbackLlmConfigId":null,"isActive":true,"isDefault":false}',
      },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("rejects an inactive default with an instruction, not a constraint name", async () => {
    const res = await post({ ...VALID_BODY, isActive: false, isDefault: true });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/must be active to be the default/i);
    expect(body.error).not.toMatch(/chk|constraint/i);
  });

  it("rejects a fallback that belongs to another organization", async () => {
    // The FK only requires the row to exist SOMEWHERE -- the same gap #161
    // found on homeworks.llm_config_id. Without this, a provider outage would
    // quietly run students on another tenant's config.
    getMock.mockResolvedValue(null);
    const res = await post({ ...VALID_BODY, fallbackLlmConfigId: OTHER_ID });
    expect(res.status).toBe(400);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("rejects a config naming itself as its fallback", async () => {
    const res = await buildApp(instructorOfA()).request(
      url(`/${CONFIG_ID}`),
      json("PATCH", { ...VALID_BODY, fallbackLlmConfigId: CONFIG_ID }),
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("reports a lost default race as a conflict, not a server fault", async () => {
    // The partial unique index is the real enforcement; two instructors
    // promoting at once means one loses. "Reload and see who won" is the
    // action, which a 503 would not convey.
    createMock.mockRejectedValue(
      new Error('duplicate key value violates unique constraint "llm_configs_org_default_uq"'),
    );
    const res = await post({ ...VALID_BODY, isDefault: true });
    expect(res.status).toBe(409);
  });

  it("creates and audits against the course's org", async () => {
    const res = await post(VALID_BODY);
    expect(res.status).toBe(201);
    expect(auditBestEffortMock).toHaveBeenCalledTimes(1);
    // SEC-002: the course's org only, never a fan-out.
    expect(auditBestEffortMock.mock.calls[0]![1]).toEqual(["org-1"]);
    expect(auditBestEffortMock.mock.calls[0]![2].action).toBe("llm_config.created");
    expect(auditBestEffortMock.mock.calls[0]![2].targetType).toBe("llm_config");
  });
});

describe("DELETE deactivates (#31)", () => {
  it("refuses to deactivate the default, naming the unblocking step", async () => {
    deactivateMock.mockResolvedValue("is_default");
    const res = await buildApp(instructorOfA()).request(
      url(`/${CONFIG_ID}`),
      { method: "DELETE" },
      TEST_ENV,
    );
    // 409, not 403: the caller is entitled to do this, the org's state does
    // not permit it yet.
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /Make another configuration the default first/i,
    );
  });

  it("404s a malformed config id without reaching the database", async () => {
    const res = await buildApp(instructorOfA()).request(
      url("/not-a-uuid"),
      { method: "DELETE" },
      TEST_ENV,
    );
    expect(res.status).toBe(404);
    expect(deactivateMock).not.toHaveBeenCalled();
  });
});

describe("POST clone (#170)", () => {
  it("requires a name for the copy", async () => {
    const res = await buildApp(instructorOfA()).request(
      url(`/${CONFIG_ID}/clone`),
      json("POST", { name: "  " }),
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect(cloneMock).not.toHaveBeenCalled();
  });

  it("404s a source in another organization, disclosing nothing", async () => {
    // Cloning must not become a way to learn that an id exists elsewhere.
    cloneMock.mockResolvedValue(null);
    const res = await buildApp(instructorOfA()).request(
      url(`/${CONFIG_ID}/clone`),
      json("POST", { name: "Copy" }),
      TEST_ENV,
    );
    expect(res.status).toBe(404);
  });

  it("returns the copy and audits it as a creation", async () => {
    const res = await buildApp(instructorOfA()).request(
      url(`/${CONFIG_ID}/clone`),
      json("POST", { name: "Experiment" }),
      TEST_ENV,
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as { isDefault: boolean }).isDefault).toBe(false);
    expect(auditBestEffortMock.mock.calls[0]![2].requestMetadata).toMatchObject({
      clonedFrom: CONFIG_ID,
    });
  });
});

describe("POST test (#31)", () => {
  const test = (body: unknown) =>
    buildApp(instructorOfA()).request(url(`/${CONFIG_ID}/test`), json("POST", body), TEST_ENV);

  it("sends the config's own prompt and settings, and returns usage", async () => {
    const res = await test({ message: "Explain a p-value." });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      text: "Hello.",
      modelName: CONFIG.modelName,
      usage: { inputTokens: 12, outputTokens: 3 },
    });
    // The config as saved is what is under test -- not defaults, and not the
    // chat route's prompt.
    expect(generateTextMock.mock.calls[0]![0]).toMatchObject({
      system: CONFIG.basePrompt,
      temperature: CONFIG.temperature,
      maxOutputTokens: CONFIG.maxCompletionTokens,
    });
  });

  it("omits the system message entirely when the config states no prompt", async () => {
    // '' is a legitimate stored state (the column defaults to it); sending an
    // empty system message would be a different test than the one saved.
    loadLlmConfigByIdMock.mockResolvedValue({ ...RESOLVED_CONFIG, basePrompt: "" });
    await test({ message: "hi" });
    expect(generateTextMock.mock.calls[0]![0]).not.toHaveProperty("system");
  });

  /** #365: the button used to hardcode `getOpenRouter(OPENROUTER_API_KEY)`
   *  whatever the config said. Since migration 0035 every organization's
   *  default is `llmoxie`/`gpt-5.3-codex`, so Test on the default sent an
   *  LLMOxie model id to openrouter.ai under an OpenRouter key. */
  it("builds the client for the config's OWN provider, not OpenRouter", async () => {
    loadLlmConfigByIdMock.mockResolvedValue({
      ...RESOLVED_CONFIG,
      provider: "llmoxie",
      modelName: "gpt-5.3-codex",
    });
    resolveApiKeyMock.mockResolvedValue("sk-llmoxie");
    await test({ message: "hi" });

    // The credential is resolved from the config itself (its credentialId, or
    // its provider's own fallback binding) -- never a fixed env var.
    expect(resolveApiKeyMock.mock.calls[0]![3]).toMatchObject({ provider: "llmoxie" });
    expect(buildProviderClientMock.mock.calls[0]![0]).toBe("llmoxie");
    expect(buildProviderClientMock.mock.calls[0]![1]).toBe("sk-llmoxie");
    expect(generateTextMock.mock.calls[0]![0].model).toMatchObject({
      provider: "llmoxie",
      apiKey: "sk-llmoxie",
      model: "gpt-5.3-codex",
    });
  });

  it("reads the config through the loader that carries its credential link", async () => {
    // `getLlmConfig`'s console projection has no credentialId, so a config
    // whose org has a linked credential could never have resolved a key.
    await test({ message: "hi" });
    expect(loadLlmConfigByIdMock).toHaveBeenCalledWith({}, "org-1", CONFIG_ID, { activeOnly: false });
  });

  it("answers 200 with ok:false when the provider refuses, and leaks nothing", async () => {
    generateTextMock.mockRejectedValue(
      new Error("401 from https://openrouter.ai/api/v1 key sk-or-v1-abcdef org_12345"),
    );
    const res = await test({ message: "hi" });
    // A 5xx here would be indistinguishable from the console being broken,
    // which is the opposite of what a test button is for.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    // The provider's own message can carry urls, org ids and key prefixes.
    expect(body.error).not.toMatch(/sk-or-v1|openrouter\.ai|org_12345|401/);
    expect(body.error).toMatch(/model id/i);
  });

  it("rejects an empty message and one past the length bound", async () => {
    expect((await test({ message: "   " })).status).toBe(400);
    expect((await test({ message: "x".repeat(4001) })).status).toBe(400);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("503s with an actionable sentence when the config's own key is unreachable", async () => {
    // #365: no longer "OPENROUTER_API_KEY is unset" specifically -- this now
    // covers every way resolveApiKey can refuse (no credential and no
    // fallback binding for THIS provider, a stale credentialId, a secret_ref
    // off the #323 allowlist).
    resolveApiKeyMock.mockRejectedValue(
      new LLMCredentialMissingError("fallback env var LLMOXIE_API_KEY is not set"),
    );
    const res = await test({ message: "hi" });
    expect(res.status).toBe(503);
    expect(generateTextMock).not.toHaveBeenCalled();
    // The message names a binding; that is server-log material, not console copy.
    expect(JSON.stringify(await res.json())).not.toMatch(/LLMOXIE_API_KEY/);
  });

  it("#425: 503s rather than 500s when the credential read itself fails transiently", async () => {
    /* resolveApiKey queries organization_credentials, so a Neon blip lands in
       the same catch as the typed errors. Narrowing that catch to
       LLMCredentialMissingError / UnsupportedLLMProviderError let a transient
       DB failure escape to Hono's default handler as a bare 500 with no
       actionable copy -- on a button whose entire purpose is to report a
       diagnosable result. */
    resolveApiKeyMock.mockRejectedValue(new Error("neon: connection reset"));
    const res = await test({ message: "hi" });
    expect(res.status).toBe(503);
    expect(generateTextMock).not.toHaveBeenCalled();
    // Still no server internals in the console copy.
    expect(JSON.stringify(await res.json())).not.toMatch(/neon/i);
  });

  it("503s rather than misrouting when the provider has no client factory", async () => {
    buildProviderClientMock.mockImplementation(() => {
      throw new UnsupportedLLMProviderError("anthropic");
    });
    expect((await test({ message: "hi" })).status).toBe(503);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  /* Their-side coverage kept from PR #382: the llmoxie case above is the one
     the old hardcoded code got wrong, but the openrouter case has to keep
     working too -- a "fix" that simply flipped the hardcoded provider would
     pass the test above and fail here. */
  it("still routes an openrouter config to openrouter", async () => {
    loadLlmConfigByIdMock.mockResolvedValue({ ...RESOLVED_CONFIG, provider: "openrouter" });
    await test({ message: "hi" });
    expect(buildProviderClientMock.mock.calls[0]![0]).toBe("openrouter");
  });

  it("404s when the config no longer exists, without reaching a provider", async () => {
    loadLlmConfigByIdMock.mockResolvedValue(null);
    const res = await test({ message: "hi" });
    expect(res.status).toBe(404);
    expect(resolveApiKeyMock).not.toHaveBeenCalled();
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  /** #390 (the follow-up staging PR #382 opened against its own fix): that
   *  implementation paired the console's `getLlmConfig` read with a second
   *  `getResolvedLLMConfigById` read, and mixed the two -- provider and
   *  credential from one, model/prompt/temperature from the other. An admin
   *  saving the config between them produced a request that was a hybrid of
   *  the old and the new row. This handler reads the row ONCE and takes
   *  everything from it, which closes that window structurally rather than
   *  by ordering; this test is what keeps a second read from creeping back. */
  it("reads the config exactly once, so an edit mid-request cannot split it", async () => {
    /* Review finding (I1): the assertions below only discriminate if the two
       possible sources disagree. RESOLVED_CONFIG mirrors CONFIG field for
       field, so with the default mocks a handler that pulled model, prompt
       and generation params off `getLlmConfig` would satisfy every value
       assertion here -- only the `getMock` call count would have caught it.
       Staging's own fixture diverged on purpose for exactly this reason.
       So: make the row the loader returns disagree with CONFIG on EVERY
       field the handler forwards, and leave getMock on CONFIG. Now each
       assertion names which read it came from. */
    const ROW_UNDER_TEST = {
      ...RESOLVED_CONFIG,
      provider: "llmoxie" as const,
      modelName: "gpt-5.3-codex",
      basePrompt: "ROW-UNDER-TEST",
      temperature: 0.11,
      maxCompletionTokens: 222,
    };
    loadLlmConfigByIdMock.mockResolvedValue(ROW_UNDER_TEST);

    await test({ message: "hi" });
    expect(loadLlmConfigByIdMock).toHaveBeenCalledTimes(1);
    // The console's own projection is not consulted by this handler at all.
    expect(getMock).not.toHaveBeenCalled();

    // Everything sent to the provider came off that single row -- and none
    // of it matches CONFIG, so a reintroduced second read fails here.
    const call = generateTextMock.mock.calls[0]![0];
    expect(call.model).toMatchObject({ provider: "llmoxie", model: "gpt-5.3-codex" });
    expect(call).toMatchObject({
      system: "ROW-UNDER-TEST",
      temperature: 0.11,
      maxOutputTokens: 222,
    });
    // The credential is resolved from that same row too, not a re-read one.
    expect(resolveApiKeyMock.mock.calls[0]![3]).toBe(ROW_UNDER_TEST);
    // Belt and braces: none of CONFIG's values leaked into the call.
    expect(call.model.model).not.toBe(CONFIG.modelName);
    expect(call.system).not.toBe(CONFIG.basePrompt);
    expect(call.temperature).not.toBe(CONFIG.temperature);
    expect(call.maxOutputTokens).not.toBe(CONFIG.maxCompletionTokens);
  });

  /** Review finding (I2): the narrowed catch's negative case. The handler
   *  turns LLMCredentialMissingError / UnsupportedLLMProviderError into
   *  "The model gateway is not configured", logged under
   *  `testLlmConfigHandler`; anything else it rethrows. Both end up 503 in
   *  production (index.ts's onError catches the rethrow), so the status is
   *  NOT what the narrowing buys -- what it buys is that an unrelated
   *  failure keeps its own generic sentence and its own log context instead
   *  of being reported to the instructor as a gateway misconfiguration they
   *  would then go and "fix". Staging's version caught everything, so this
   *  case was indistinguishable from a genuinely missing credential. */
  it("does not relabel an unrelated failure as a gateway misconfiguration", async () => {
    resolveApiKeyMock.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.1:5432"));
    const res = await test({ message: "hi" });
    const body = await res.text();
    expect(body).not.toMatch(/model gateway is not configured/i);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("audits the test, because it spends money and reaches a provider", async () => {
    await test({ message: "hi" });
    expect(auditBestEffortMock.mock.calls[0]![2].action).toBe("llm_config.tested");
  });
});
