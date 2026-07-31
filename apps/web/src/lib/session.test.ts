import { describe, it, expect, beforeAll } from "vitest";
import {
  createSessionPayload,
  loadSessionKey,
  sealSession,
  unsealSession,
} from "./session";

let key: CryptoKey;

beforeAll(async () => {
  key = await loadSessionKey({
    SESSION_SECRET: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
  } as Env);
});

describe("sealSession / unsealSession", () => {
  it("round-trips a valid payload", async () => {
    const payload = createSessionPayload("user-1", "workos-1");
    const sealed = await sealSession(payload, key);
    const unsealed = await unsealSession(sealed, key);
    expect(unsealed).toEqual(payload);
  });

  it("produces a different cookie value each time (random IV)", async () => {
    const payload = createSessionPayload("user-1", "workos-1");
    const a = await sealSession(payload, key);
    const b = await sealSession(payload, key);
    expect(a).not.toBe(b);
  });

  it("rejects an expired session", async () => {
    const payload = createSessionPayload(
      "user-1",
      "workos-1",
      Date.now() - 1000 * 60 * 60 * 24 * 30,
    );
    const sealed = await sealSession(payload, key);
    expect(await unsealSession(sealed, key)).toBeNull();
  });

  it("rejects a tampered cookie value", async () => {
    const payload = createSessionPayload("user-1", "workos-1");
    const sealed = await sealSession(payload, key);
    const tampered = sealed.slice(0, -2) + (sealed.slice(-2) === "AA" ? "BB" : "AA");
    expect(await unsealSession(tampered, key)).toBeNull();
  });

  it("rejects a cookie sealed with a different key", async () => {
    const otherKey = await loadSessionKey({
      SESSION_SECRET: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
    } as Env);
    const payload = createSessionPayload("user-1", "workos-1");
    const sealed = await sealSession(payload, key);
    expect(await unsealSession(sealed, otherKey)).toBeNull();
  });

  it("rejects garbage input without throwing", async () => {
    expect(await unsealSession("not-a-valid-cookie", key)).toBeNull();
  });
});

describe("loadSessionKey", () => {
  it("throws a clear error when SESSION_SECRET is missing", async () => {
    await expect(loadSessionKey({} as Env)).rejects.toThrow(/SESSION_SECRET/);
  });
});
