import * as pulumi from "@pulumi/pulumi";
import { describe, expect, it } from "vitest";
import {
  loadDeploymentInputs,
  parseProductionDeploymentEnvironment,
  RUNTIME_SECRET_NAMES,
} from "./deployment-inputs.js";

const valid = {
  DATABASE_PASSWORD: "FakeRdsPassw0rd!",
  WORKOS_API_KEY: "sk_fake-workos-key",
  WORKOS_CLIENT_ID: "client_fake-workos-id",
  WORKOS_WEBHOOK_SECRET: "fake-webhook-value",
  OPENROUTER_API_KEY: "sk-or-fake-openrouter-key",
  LLMOXIE_API_KEY: "fake-llmoxie-value",
  SESSION_SECRET: Buffer.alloc(32, 1).toString("base64"),
  ENCRYPTION_KEY: Buffer.alloc(32, 2).toString("base64"),
  BLIND_INDEX_KEY: Buffer.alloc(32, 3).toString("base64"),
  LLMOXIE_BASE_URL: "https://llmoxie.example.test/api/v1",
};

function rejectsSetting(name: keyof typeof valid, value: string | undefined) {
  const environment = { ...valid, [name]: value };
  let message = "";
  try {
    parseProductionDeploymentEnvironment(environment);
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).toContain(name);
  if (value) expect(message).not.toContain(value);
}

async function resolveOutput(value: pulumi.Output<string>): Promise<string> {
  return new Promise((resolve) => {
    value.apply(resolve);
  });
}

describe("production deployment inputs", () => {
  it("accepts the complete production deployment environment", () => {
    const parsed = parseProductionDeploymentEnvironment(valid);
    expect(parsed).toEqual({
      databasePassword: valid.DATABASE_PASSWORD,
      runtimeSecrets: {
        WORKOS_API_KEY: valid.WORKOS_API_KEY,
        WORKOS_CLIENT_ID: valid.WORKOS_CLIENT_ID,
        WORKOS_WEBHOOK_SECRET: valid.WORKOS_WEBHOOK_SECRET,
        OPENROUTER_API_KEY: valid.OPENROUTER_API_KEY,
        LLMOXIE_API_KEY: valid.LLMOXIE_API_KEY,
        SESSION_SECRET: valid.SESSION_SECRET,
        ENCRYPTION_KEY: valid.ENCRYPTION_KEY,
        BLIND_INDEX_KEY: valid.BLIND_INDEX_KEY,
      },
      llmoxieBaseUrl: valid.LLMOXIE_BASE_URL,
    });
    expect(Object.keys(parsed.runtimeSecrets)).toEqual(RUNTIME_SECRET_NAMES);
  });

  it("rejects every missing or empty required setting without echoing its value", () => {
    for (const name of Object.keys(valid).filter((name) => name !== "OPENROUTER_API_KEY") as (keyof typeof valid)[]) {
      rejectsSetting(name, undefined);
      rejectsSetting(name, "");
    }
  });

  it.each([undefined, ""])("accepts production without an OpenRouter key (%s)", (openRouterApiKey) => {
    const parsed = parseProductionDeploymentEnvironment({
      ...valid,
      OPENROUTER_API_KEY: openRouterApiKey,
    });

    expect(parsed.runtimeSecrets).not.toHaveProperty("OPENROUTER_API_KEY");
  });

  it("rejects whitespace-padded values rather than normalizing credentials", () => {
    for (const name of Object.keys(valid) as (keyof typeof valid)[]) {
      rejectsSetting(name, ` ${valid[name]}`);
      rejectsSetting(name, `${valid[name]}\n`);
    }
  });

  it("requires three distinct canonical base64 encodings of exactly 32 bytes", () => {
    for (const name of ["SESSION_SECRET", "ENCRYPTION_KEY", "BLIND_INDEX_KEY"] as const) {
      rejectsSetting(name, Buffer.alloc(31, 4).toString("base64"));
      rejectsSetting(name, Buffer.alloc(33, 4).toString("base64"));
      rejectsSetting(name, `${valid[name]}=`);
      rejectsSetting(name, valid[name].replace(/=+$/, ""));
      rejectsSetting(name, Buffer.alloc(32, 255).toString("base64").replace(/\//g, "_"));
    }
    rejectsSetting("ENCRYPTION_KEY", valid.SESSION_SECRET);
    rejectsSetting("BLIND_INDEX_KEY", valid.SESSION_SECRET);
    rejectsSetting("BLIND_INDEX_KEY", valid.ENCRYPTION_KEY);
  });

  it("enforces RDS PostgreSQL password constraints without echoing the password", () => {
    for (const value of ["short7", "x".repeat(129), "bad/passw0rd", "bad'passw0rd", 'bad"passw0rd', "bad@passw0rd", "bad passw0rd", "bad\tpassw0rd", "badépassw0rd"]) {
      rejectsSetting("DATABASE_PASSWORD", value);
    }
    expect(parseProductionDeploymentEnvironment({ ...valid, DATABASE_PASSWORD: "a".repeat(8) }).databasePassword).toBe("a".repeat(8));
    expect(parseProductionDeploymentEnvironment({ ...valid, DATABASE_PASSWORD: "a".repeat(128) }).databasePassword).toBe("a".repeat(128));
  });

  it("requires an HTTPS LLMoxie v1 URL without credentials query or fragment", () => {
    for (const value of ["http://llmoxie.example.test/v1", "//llmoxie.example.test/v1", "https://llmoxie.example.test/", "https://llmoxie.example.test/v1/", "https://llmoxie.example.test/\tv1", "https://user:pass@llmoxie.example.test/v1", "https://llmoxie.example.test/v1?token=x", "https://llmoxie.example.test/v1#fragment"]) {
      rejectsSetting("LLMOXIE_BASE_URL", value);
    }
  });

  it("rejects non-canonical URL authorities before credentials can be normalized", () => {
    for (const value of [
      "https:///fake-user:fake-password@example.test/v1",
      "https:////fake-user:fake-password@example.test/v1",
      "https://\\fake-user:fake-password@example.test/v1",
      "https:\\\\fake-user:fake-password@example.test/v1",
      "https:///llmoxie.example.test/v1",
      "https://\\llmoxie.example.test/v1",
    ]) {
      rejectsSetting("LLMOXIE_BASE_URL", value);
    }
  });

  it("applies only provider-guaranteed credential prefixes", () => {
    rejectsSetting("WORKOS_API_KEY", "wrong-fake-workos-key");
    rejectsSetting("WORKOS_CLIENT_ID", "wrong-fake-client-id");
    rejectsSetting("OPENROUTER_API_KEY", "wrong-fake-openrouter-key");
    const parsed = parseProductionDeploymentEnvironment({
      ...valid,
      WORKOS_WEBHOOK_SECRET: "arbitrary-webhook-value",
      LLMOXIE_API_KEY: "arbitrary-llmoxie-value",
    });
    expect(parsed.runtimeSecrets.WORKOS_WEBHOOK_SECRET).toBe("arbitrary-webhook-value");
    expect(parsed.runtimeSecrets.LLMOXIE_API_KEY).toBe("arbitrary-llmoxie-value");
  });

  it("marks production secrets as Pulumi secrets while retaining the plain endpoint", async () => {
    const result = loadDeploymentInputs("production", undefined, valid);
    expect(await pulumi.isSecret(result.databasePassword)).toBe(true);
    expect(await pulumi.isSecret(result.runtimeSecretValue)).toBe(true);
    expect(await resolveOutput(result.databasePassword)).toBe(valid.DATABASE_PASSWORD);
    expect(JSON.parse(await resolveOutput(result.runtimeSecretValue))).toEqual(
      parseProductionDeploymentEnvironment(valid).runtimeSecrets,
    );
    expect(result.llmoxieBaseUrl).toBe(valid.LLMOXIE_BASE_URL);
  });

  it("uses encrypted Pulumi config for local and staging", async () => {
    const config = {
      requireSecret: (key: string) => pulumi.secret(key === "databasePassword" ? "fake-local-password" : "{\"fake\":\"runtime\"}"),
    } as pulumi.Config;
    for (const environment of ["local", "staging"] as const) {
      const result = loadDeploymentInputs(environment, config, {});
      expect(await resolveOutput(result.databasePassword)).toBe("fake-local-password");
      expect(await resolveOutput(result.runtimeSecretValue)).toBe('{"fake":"runtime"}');
      expect(await pulumi.isSecret(result.databasePassword)).toBe(true);
      expect(await pulumi.isSecret(result.runtimeSecretValue)).toBe(true);
      expect(result.llmoxieBaseUrl).toBeUndefined();
    }
  });
});
