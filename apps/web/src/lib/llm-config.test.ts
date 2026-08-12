import { describe, it, expect, vi } from "vitest";
import {
  buildProviderClient,
  resolveApiKey,
  LLMConfigNotFoundError,
  LLMCredentialMissingError,
  UnsupportedLLMProviderError,
  type ResolvedLLMConfig,
} from "./llm-config";

vi.mock("./ai", () => ({
  getOpenRouter: (apiKey: string) => ({ __fake: "openrouter-client", apiKey }),
}));

const baseConfig: ResolvedLLMConfig = {
  id: "config-1",
  provider: "openrouter",
  modelName: "some/model",
  temperature: 0.7,
  maxCompletionTokens: 1000,
  credentialId: null,
};

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
    const key = await resolveApiKey({ OPENROUTER_API_KEY: "sk-env-fallback" }, db, orgScope, baseConfig);
    expect(key).toBe("sk-env-fallback");
  });

  it("throws LLMCredentialMissingError when no credential AND no fallback env var is set", async () => {
    const db = {} as never;
    await expect(resolveApiKey({}, db, orgScope, baseConfig)).rejects.toBeInstanceOf(LLMCredentialMissingError);
  });

  it("throws LLMCredentialMissingError when no credential and the provider has no fallback env var mapping at all", async () => {
    const db = {} as never;
    const localConfig: ResolvedLLMConfig = { ...baseConfig, provider: "local" };
    await expect(
      resolveApiKey({ OPENROUTER_API_KEY: "sk-irrelevant" }, db, orgScope, localConfig),
    ).rejects.toBeInstanceOf(LLMCredentialMissingError);
  });

  it("resolves through a linked credential's secretRef when credentialId is set", async () => {
    const selectMock = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ secretRef: "MY_ORG_OPENROUTER_KEY" }]),
      }),
    });
    const db = { select: selectMock } as never;
    const config: ResolvedLLMConfig = { ...baseConfig, credentialId: "cred-1" };

    const key = await resolveApiKey({ MY_ORG_OPENROUTER_KEY: "sk-from-credential" }, db, orgScope, config);
    expect(key).toBe("sk-from-credential");
  });

  it("throws LLMCredentialMissingError when the linked credential row doesn't resolve (deleted or wrong org)", async () => {
    const selectMock = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
    });
    const db = { select: selectMock } as never;
    const config: ResolvedLLMConfig = { ...baseConfig, credentialId: "cred-gone" };

    await expect(resolveApiKey({}, db, orgScope, config)).rejects.toBeInstanceOf(LLMCredentialMissingError);
  });

  it("throws LLMCredentialMissingError when the credential's secretRef names an env var that isn't actually set", async () => {
    const selectMock = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ secretRef: "UNSET_SECRET" }]),
      }),
    });
    const db = { select: selectMock } as never;
    const config: ResolvedLLMConfig = { ...baseConfig, credentialId: "cred-1" };

    await expect(resolveApiKey({}, db, orgScope, config)).rejects.toBeInstanceOf(LLMCredentialMissingError);
  });
});
