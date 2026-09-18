import { describe, expect, it, vi } from "vitest";

const { poolEnd, poolOn } = vi.hoisted(() => ({
  poolEnd: vi.fn().mockResolvedValue(undefined),
  poolOn: vi.fn(),
}));

vi.mock("pg", () => ({ Pool: vi.fn(() => ({ end: poolEnd, on: poolOn })) }));
vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: vi.fn(() => ({ driver: "node-postgres" })),
}));

import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { closeDb, makeDb } from "../db/client";
import { loadRuntimeConfig } from "./config";

const runtimeEnvironment = {
  APP_URL: "https://llteacher.example.edu",
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
  STORAGE_ENDPOINT: "http://localhost:9000",
  STORAGE_BUCKET: "llteacher-materials",
  STORAGE_ACCESS_KEY_ID: "minioadmin",
  STORAGE_SECRET_ACCESS_KEY: "minioadmin",
  KNOWLEDGE_ROOT: "/mnt/knowledge",
} satisfies NodeJS.ProcessEnv;

describe("loadRuntimeConfig", () => {
  it("rejects a runtime without DATABASE_URL", () => {
    const environment: NodeJS.ProcessEnv = { ...runtimeEnvironment };
    delete environment.DATABASE_URL;
    expect(() => loadRuntimeConfig(environment)).toThrow("DATABASE_URL is required");
  });

  it.each([
    "APP_URL",
    "WORKOS_API_KEY",
    "WORKOS_CLIENT_ID",
    "OPENROUTER_API_KEY",
    "LLMOXIE_API_KEY",
    "SESSION_SECRET",
    "ENCRYPTION_KEY",
    "BLIND_INDEX_KEY",
    "WORKOS_WEBHOOK_SECRET",
  ])("rejects a runtime without %s", (name) => {
    const environment: NodeJS.ProcessEnv = { ...runtimeEnvironment };
    delete environment[name];
    expect(() => loadRuntimeConfig(environment)).toThrow(`${name} is required`);
  });

  it.each(["ftp://llteacher.example.edu", "https://llteacher.example.edu/path", "not a url"])(
    "rejects an invalid APP_URL origin (%s)",
    (appUrl) => expect(() => loadRuntimeConfig({ ...runtimeEnvironment, APP_URL: appUrl })).toThrow("APP_URL"),
  );

  it("starts without the storage and knowledge variables, leaving those features unconfigured", () => {
    const { STORAGE_ENDPOINT, STORAGE_BUCKET, STORAGE_ACCESS_KEY_ID, STORAGE_SECRET_ACCESS_KEY, KNOWLEDGE_ROOT, ...bare } = runtimeEnvironment;
    void [STORAGE_ENDPOINT, STORAGE_BUCKET, STORAGE_ACCESS_KEY_ID, STORAGE_SECRET_ACCESS_KEY, KNOWLEDGE_ROOT];
    const config = loadRuntimeConfig(bare);
    expect(config.DATABASE_URL).toBe(bare.DATABASE_URL);
    expect(config.KNOWLEDGE_ROOT).toBeUndefined();
    expect(config.STORAGE_BUCKET).toBeUndefined();
  });

  it("returns the Node runtime bindings without a Worker ASSETS binding", () => {
    expect(loadRuntimeConfig({ ...runtimeEnvironment, ASSETS: "worker-only" })).toEqual(runtimeEnvironment);
  });
});

describe("makeDb", () => {
  it("reuses one process-owned node-postgres client", () => {
    const databaseUrl = runtimeEnvironment.DATABASE_URL!;

    const db = makeDb(databaseUrl);
    const sameDb = makeDb(databaseUrl);

    expect(Pool).toHaveBeenCalledTimes(1);
    expect(Pool).toHaveBeenCalledWith({ connectionString: databaseUrl, max: 10 });
    expect(poolOn).toHaveBeenCalledWith("error", expect.any(Function));
    expect(drizzle).toHaveBeenCalledWith(expect.objectContaining({ end: poolEnd }), expect.objectContaining({ schema: expect.any(Object) }));
    expect(db).toEqual({ driver: "node-postgres" });
    expect(sameDb).toBe(db);
  });

  it("closes the process pool before rebuilding it", async () => {
    await closeDb();
    vi.clearAllMocks();

    const db = makeDb(runtimeEnvironment.DATABASE_URL!);
    await closeDb();
    const rebuiltDb = makeDb(runtimeEnvironment.DATABASE_URL!);

    expect(poolEnd).toHaveBeenCalledOnce();
    expect(Pool).toHaveBeenCalledTimes(2);
    expect(rebuiltDb).not.toBe(db);
  });

  it("rejects a different URL while the process pool is active", async () => {
    await closeDb();
    makeDb(runtimeEnvironment.DATABASE_URL!);

    expect(() => makeDb("postgres://other:secret@localhost/other")).toThrow(
      "closeDb",
    );
  });
});
