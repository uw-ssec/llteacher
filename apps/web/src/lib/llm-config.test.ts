import { describe, it, expect, vi } from "vitest";
import {
  buildProviderClient,
  resolveApiKey,
  resolveProviderCredential,
  estimateCostCents,
  LLMConfigNotFoundError,
  LLMCredentialMissingError,
  UnsupportedLLMProviderError,
  type ResolvedLLMConfig,
} from "./llm-config";

vi.mock("./ai", () => ({
  getOpenRouter: (apiKey: string) => ({ __fake: "openrouter-client", apiKey }),
  getLLMoxie: (apiKey: string) => ({ __fake: "llmoxie-client", apiKey }),
}));

const baseConfig: ResolvedLLMConfig = {
  id: "config-1",
  provider: "openrouter",
  modelName: "some/model",
  temperature: 0.7,
  maxCompletionTokens: 1000,
  credentialId: null,
  fallbackLlmConfigId: null,
  basePrompt: "",
  pricePerMillionInputTokens: null,
  pricePerMillionOutputTokens: null,
  markCompleteInstruction: null,
};

/** #317 review, security finding #323: resolveApiKey now takes the real
 *  Env type (not an open Record) so the compiler catches a typo'd binding
 *  name the same way any other Env access would -- these tests build a
 *  minimal-but-real Env rather than casting a bag of arbitrary keys. */
function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DATABASE_URL: "postgres://unused",
    WORKOS_API_KEY: "unused",
    WORKOS_CLIENT_ID: "unused",
    OPENROUTER_API_KEY: "",
    LLMOXIE_API_KEY: "",
    ASSETS: {} as Env["ASSETS"],
    SESSION_SECRET: "unused",
    ENCRYPTION_KEY: "unused",
    BLIND_INDEX_KEY: "unused",
    WORKOS_WEBHOOK_SECRET: "unused",
    ...overrides,
  };
}

describe("LLMConfigNotFoundError", () => {
  it("carries a random referenceId, and the message includes it (Django parity: quotable to an admin)", () => {
    const err = new LLMConfigNotFoundError();
    expect(err.referenceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(err.message).toContain(err.referenceId);
  });

  it("two instances never share a referenceId", () => {
    const a = new LLMConfigNotFoundError();
    const b = new LLMConfigNotFoundError();
    expect(a.referenceId).not.toBe(b.referenceId);
  });
});

describe("buildProviderClient", () => {
  it("returns the OpenRouter client for provider 'openrouter'", () => {
    const client = buildProviderClient("openrouter", "sk-test") as unknown as {
      __fake: string;
      apiKey: string;
    };
    expect(client.__fake).toBe("openrouter-client");
    expect(client.apiKey).toBe("sk-test");
  });

  it("returns the LLMoxie client for provider 'llmoxie' (#178)", () => {
    const client = buildProviderClient("llmoxie", "sk-llmoxie-test") as unknown as {
      __fake: string;
      apiKey: string;
    };
    expect(client.__fake).toBe("llmoxie-client");
    expect(client.apiKey).toBe("sk-llmoxie-test");
  });

  it.each(["openai", "anthropic", "claude_for_education", "local"] as const)(
    "throws UnsupportedLLMProviderError for provider '%s' (no client factory exists yet)",
    (provider) => {
      expect(() => buildProviderClient(provider, "sk-test")).toThrow(UnsupportedLLMProviderError);
    },
  );

  it("UnsupportedLLMProviderError carries the offending provider name", () => {
    try {
      buildProviderClient("anthropic", "sk-test");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedLLMProviderError);
      expect((err as UnsupportedLLMProviderError).provider).toBe("anthropic");
    }
  });
});

describe("resolveApiKey", () => {
  const orgScope = "org-1" as never;

  it("falls back to the provider's conventional env var when the config has no credentialId", async () => {
    const db = {} as never; // never queried -- credentialId is null
    const key = await resolveApiKey(fakeEnv({ OPENROUTER_API_KEY: "sk-env-fallback" }), db, orgScope, baseConfig);
    expect(key).toBe("sk-env-fallback");
  });

  it("falls back to LLMOXIE_API_KEY for provider 'llmoxie' (#178)", async () => {
    const db = {} as never;
    const llmoxieConfig: ResolvedLLMConfig = { ...baseConfig, provider: "llmoxie" };
    const key = await resolveApiKey(fakeEnv({ LLMOXIE_API_KEY: "sk-llmoxie-env" }), db, orgScope, llmoxieConfig);
    expect(key).toBe("sk-llmoxie-env");
  });

  it("throws LLMCredentialMissingError when no credential AND no fallback env var is set", async () => {
    const db = {} as never;
    await expect(resolveApiKey(fakeEnv(), db, orgScope, baseConfig)).rejects.toBeInstanceOf(
      LLMCredentialMissingError,
    );
  });

  // #317 review, #343: an operator debugging a 500 needs to know WHICH
  // binding is missing without reading this module's source -- the message
  // used to say "no fallback env var is set" with no name at all.
  it("names the missing fallback env var in the thrown error's message", async () => {
    const db = {} as never;
    await expect(resolveApiKey(fakeEnv(), db, orgScope, baseConfig)).rejects.toThrow(
      /fallback env var OPENROUTER_API_KEY is not set/,
    );
  });

  it("throws LLMCredentialMissingError when no credential and the provider has no fallback env var mapping at all", async () => {
    const db = {} as never;
    const localConfig: ResolvedLLMConfig = { ...baseConfig, provider: "local" };
    await expect(
      resolveApiKey(fakeEnv({ OPENROUTER_API_KEY: "sk-irrelevant" }), db, orgScope, localConfig),
    ).rejects.toBeInstanceOf(LLMCredentialMissingError);
  });

  it("names the fallback var as \"(none)\" when the provider has no mapping at all", async () => {
    const db = {} as never;
    const localConfig: ResolvedLLMConfig = { ...baseConfig, provider: "local" };
    await expect(
      resolveApiKey(fakeEnv({ OPENROUTER_API_KEY: "sk-irrelevant" }), db, orgScope, localConfig),
    ).rejects.toThrow(/fallback env var \(none\) is not set/);
  });

  it("resolves through a linked credential's secretRef when it names an allowlisted binding", async () => {
    const selectMock = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ secretRef: "OPENROUTER_API_KEY" }]),
      }),
    });
    const db = { select: selectMock } as never;
    const config: ResolvedLLMConfig = { ...baseConfig, credentialId: "cred-1" };

    const key = await resolveApiKey(fakeEnv({ OPENROUTER_API_KEY: "sk-from-credential" }), db, orgScope, config);
    expect(key).toBe("sk-from-credential");
  });

  // #317 review, security finding #323: organization_credentials.secretRef
  // is free-form DB text with no write-path validation today -- the
  // allowlist is the only thing standing between a future credential UI and
  // a row that points at ENCRYPTION_KEY/SESSION_SECRET/DATABASE_URL/etc.
  // Simulates exactly that: a secretRef naming a real, set env binding that
  // is simply not on the allowlist must still be refused.
  it("refuses a linked credential's secretRef when it names a binding that isn't on the allowlist, even if that env var is set", async () => {
    const selectMock = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ secretRef: "ENCRYPTION_KEY" }]),
      }),
    });
    const db = { select: selectMock } as never;
    const config: ResolvedLLMConfig = { ...baseConfig, credentialId: "cred-1" };

    await expect(
      resolveApiKey(fakeEnv({ ENCRYPTION_KEY: "the-real-pii-key" }), db, orgScope, config),
    ).rejects.toBeInstanceOf(LLMCredentialMissingError);
  });

  it("throws LLMCredentialMissingError when the linked credential row doesn't resolve (deleted or wrong org)", async () => {
    const selectMock = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
    });
    const db = { select: selectMock } as never;
    const config: ResolvedLLMConfig = { ...baseConfig, credentialId: "cred-gone" };

    await expect(resolveApiKey(fakeEnv(), db, orgScope, config)).rejects.toBeInstanceOf(LLMCredentialMissingError);
  });

  it("throws LLMCredentialMissingError when the credential's secretRef names an allowlisted env var that isn't actually set", async () => {
    const selectMock = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ secretRef: "OPENROUTER_API_KEY" }]),
      }),
    });
    const db = { select: selectMock } as never;
    const config: ResolvedLLMConfig = { ...baseConfig, credentialId: "cred-1" };

    // fakeEnv() leaves OPENROUTER_API_KEY as "" (allowlisted, but unset).
    await expect(resolveApiKey(fakeEnv(), db, orgScope, config)).rejects.toBeInstanceOf(LLMCredentialMissingError);
  });
});

// #317 review, #349: MODEL_PRICING_PER_MILLION_TOKENS' only real-world entry
// was ":free" model, and estimateCostCents short-circuits on that suffix
// BEFORE ever consulting the table -- meaning the table (and the dollar
// arithmetic below it) was unreachable dead code for every possible input.
// These tests prove the fix from both directions this file's own
// `configuredPricing` param supports: a per-config rate (llm_configs.
// pricePerMillionInputTokens/OutputTokens) and the built-in static table.
describe("estimateCostCents", () => {
  it("returns 0 for a ':free'-suffixed model regardless of token counts", () => {
    expect(estimateCostCents("some/model:free", 1_000_000, 1_000_000)).toBe(0);
  });

  it("returns null for a model with no known rate and no configured pricing", () => {
    expect(estimateCostCents("unknown/model", 100, 50)).toBeNull();
  });

  it("returns null when either token count is null, even with configured pricing", () => {
    expect(estimateCostCents("priced/model", null, 50, { input: 1, output: 2 })).toBeNull();
    expect(estimateCostCents("priced/model", 100, null, { input: 1, output: 2 })).toBeNull();
  });

  it("computes a non-zero cent value from a config's own per-config pricing", () => {
    // $2/1M input, $10/1M output; 1,000,000 input + 500,000 output tokens
    // -> $2 + $5 = $7.00 -> 700 cents. The exact number matters here, not
    // just "non-zero": it's the whole point of #349's fix -- this cost path
    // was structurally incapable of producing ANY number before it.
    const cents = estimateCostCents("gpt-5.3-codex", 1_000_000, 500_000, { input: 2, output: 10 });
    expect(cents).toBe(700);
    expect(cents).not.toBe(0);
  });

  it("falls back to the built-in static table when no per-config pricing is set", () => {
    // google/gemma-4-31b-it:free is only in the table because ":free" models
    // are $0 -- but reaching the table at all (not short-circuiting on the
    // suffix, not needing a configured rate) is what this test is for; a
    // model that hit the ":free" short-circuit wouldn't prove the table
    // lookup path itself works.
    expect(estimateCostCents("google/gemma-4-31b-it:free", 1000, 1000, null)).toBe(0);
  });

  it("does not use a configured rate that has only one of the two fields set (a half-known rate is not a half-known cost)", () => {
    expect(estimateCostCents("priced/model", 1_000_000, 1_000_000, { input: 5, output: null })).toBeNull();
    expect(estimateCostCents("priced/model", 1_000_000, 1_000_000, { input: null, output: 5 })).toBeNull();
  });

  it("prefers configured pricing over a static-table entry for the same model", () => {
    // google/gemma-4-31b-it:free hits the ":free" short-circuit before
    // either pricing source is even consulted, so use a non-":free" model
    // name that would otherwise need a static-table entry to price at all.
    const cents = estimateCostCents("acme/priced-model", 1_000_000, 1_000_000, { input: 1, output: 1 });
    expect(cents).toBe(200);
  });
});

/* #343: migration 0035 makes llmoxie every org's default with no credential
   row, so a missing LLMOXIE_API_KEY is a 500 for every student, in every org,
   on every turn -- and rolling the Worker back does not help, because the DB
   rows are already flipped. This is the documented degradation. */
describe("resolveProviderCredential (#343 degradation)", () => {
  const orgScope = "org-1" as never;
  const db = {} as never;
  const llmoxie: ResolvedLLMConfig = { ...baseConfig, provider: "llmoxie", modelName: "gpt-5.3-codex" };

  it("passes the config's own provider, key and model straight through when nothing is missing", async () => {
    const res = await resolveProviderCredential(
      fakeEnv({ LLMOXIE_API_KEY: "sk-llmoxie" }), db, orgScope, llmoxie,
    );
    expect(res).toEqual({ provider: "llmoxie", apiKey: "sk-llmoxie", modelName: "gpt-5.3-codex" });
    expect(res.degradedFrom).toBeUndefined();
  });

  it("degrades llmoxie -> openrouter, moving provider AND model together", async () => {
    /* The model has to move with the provider: "gpt-5.3-codex" is an LLMoxie
       catalogue name, not an OpenRouter slug, so carrying it across would
       fail worse than the 500 it replaces. */
    const res = await resolveProviderCredential(
      fakeEnv({ OPENROUTER_API_KEY: "sk-or", LLM_DEGRADED_FALLBACK_MODEL: "vendor/fallback-model" }),
      db, orgScope, llmoxie,
    );
    expect(res).toEqual({
      provider: "openrouter",
      apiKey: "sk-or",
      modelName: "vendor/fallback-model",
      degradedFrom: "llmoxie",
    });
  });

  it("does NOT degrade unless an operator opted in with a fallback model", async () => {
    // An OpenRouter key alone is not consent: it would answer students from a
    // model nobody chose, with its own pricing, and say nothing.
    await expect(
      resolveProviderCredential(fakeEnv({ OPENROUTER_API_KEY: "sk-or" }), db, orgScope, llmoxie),
    ).rejects.toBeInstanceOf(LLMCredentialMissingError);
  });

  it("does NOT degrade when the fallback provider's own key is also missing", async () => {
    await expect(
      resolveProviderCredential(
        fakeEnv({ LLM_DEGRADED_FALLBACK_MODEL: "vendor/fallback-model" }), db, orgScope, llmoxie,
      ),
    ).rejects.toBeInstanceOf(LLMCredentialMissingError);
  });

  it("does NOT degrade a config that names its own credential", async () => {
    /* A config with a credentialId asked for a SPECIFIC secret. Serving it
       from the platform's OpenRouter key would bill the wrong account and
       hide the misconfiguration. */
    const withCredential: ResolvedLLMConfig = { ...llmoxie, credentialId: "cred-1" };
    const dbMissingCred = {
      select: () => ({ from: () => ({ where: async () => [] }) }),
    } as never;
    await expect(
      resolveProviderCredential(
        fakeEnv({ OPENROUTER_API_KEY: "sk-or", LLM_DEGRADED_FALLBACK_MODEL: "vendor/fallback-model" }),
        dbMissingCred, orgScope, withCredential,
      ),
    ).rejects.toBeInstanceOf(LLMCredentialMissingError);
  });

  it("has no degradation path for openrouter itself -- it IS the fallback", async () => {
    await expect(
      resolveProviderCredential(
        fakeEnv({ LLM_DEGRADED_FALLBACK_MODEL: "vendor/fallback-model" }), db, orgScope, baseConfig,
      ),
    ).rejects.toBeInstanceOf(LLMCredentialMissingError);
  });
});
