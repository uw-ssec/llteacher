import { describe, it, expect } from "vitest";
import { envFromProcess } from "./node";

const FULL = {
  DATABASE_URL: "postgres://x", WORKOS_API_KEY: "k", WORKOS_CLIENT_ID: "c",
  OPENROUTER_API_KEY: "o", LLMOXIE_API_KEY: "l", SESSION_SECRET: "s",
  ENCRYPTION_KEY: "e", BLIND_INDEX_KEY: "b", WORKOS_WEBHOOK_SECRET: "w",
  STORAGE_ENDPOINT: "http://s3", STORAGE_BUCKET: "bkt", STORAGE_ACCESS_KEY_ID: "a",
  STORAGE_SECRET_ACCESS_KEY: "z", KNOWLEDGE_ROOT: "/tmp/k",
};

describe("envFromProcess", () => {
  it("builds an Env with a 404 ASSETS stub", async () => {
    const env = envFromProcess(FULL);
    expect(env.KNOWLEDGE_ROOT).toBe("/tmp/k");
    const res = await env.ASSETS.fetch(new Request("http://x/"));
    expect(res.status).toBe(404);
  });
  it("names every missing variable", () => {
    const { KNOWLEDGE_ROOT: _omit, ...partial } = FULL;
    expect(() => envFromProcess(partial)).toThrow(/KNOWLEDGE_ROOT/);
  });
});
