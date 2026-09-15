import { describe, expect, it, vi } from "vitest";

vi.mock("pg", () => ({ Pool: vi.fn() }));
vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: vi.fn(() => ({ driver: "node-postgres" })),
}));

import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { makeDb } from "../db/client";
import { loadRuntimeConfig } from "./config";

const runtimeEnvironment = {
  DATABASE_URL: "postgres://llteacher:password@localhost:5432/llteacher",
  WORKOS_API_KEY: "workos-api-key",
  WORKOS_CLIENT_ID: "workos-client-id",
  OPENROUTER_API_KEY: "openrouter-api-key",
  LLMOXIE_API_KEY: "llmoxie-api-key",
  LLMOXIE_BASE_URL: "https://llmoxie.example.test",
  LLM_DEGRADED_MODEL: "openai/gpt-4.1-mini",
  SESSION_SECRET: "session-secret",
  ENCRYPTION_KEY: "encryption-key",
  BLIND_INDEX_KEY: "blind-index-key",
  WORKOS_WEBHOOK_SECRET: "webhook-secret",
} satisfies NodeJS.ProcessEnv;

describe("loadRuntimeConfig", () => {
  it("rejects a runtime without DATABASE_URL", () => {
    expect(() => loadRuntimeConfig({})).toThrow("DATABASE_URL is required");
  });

  it("returns the Node runtime bindings without a Worker ASSETS binding", () => {
    expect(loadRuntimeConfig({ ...runtimeEnvironment, ASSETS: "worker-only" })).toEqual(runtimeEnvironment);
  });
});

describe("makeDb", () => {
  it("creates Drizzle from a node-postgres pool", () => {
    const databaseUrl = runtimeEnvironment.DATABASE_URL!;

    const db = makeDb(databaseUrl);

    expect(Pool).toHaveBeenCalledWith({ connectionString: databaseUrl, max: 10 });
    expect(drizzle).toHaveBeenCalledWith(expect.any(Pool), expect.objectContaining({ schema: expect.any(Object) }));
    expect(db).toEqual({ driver: "node-postgres" });
  });
});
