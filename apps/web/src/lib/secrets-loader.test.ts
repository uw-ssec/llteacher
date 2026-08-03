import { describe, it, expect } from "vitest";
import { loadIdentityCipherKeys } from "./secrets-loader";

function randomB64(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64");
}

describe("loadIdentityCipherKeys", () => {
  it("imports valid base64 keys into CryptoKey objects", async () => {
    const env = {
      ENCRYPTION_KEY: randomB64(32),
      BLIND_INDEX_KEY: randomB64(32),
    } as Env;
    const keys = await loadIdentityCipherKeys(env);
    expect(keys.encryptionKey).toBeDefined();
    expect(keys.blindIndexKey).toBeDefined();
    expect(keys.encryptionKeyId).toBe("k1");
  });

  it("throws a clear error when ENCRYPTION_KEY is missing", async () => {
    const env = { BLIND_INDEX_KEY: randomB64(32) } as Env;
    await expect(loadIdentityCipherKeys(env)).rejects.toThrow(/ENCRYPTION_KEY/);
  });

  it("throws a clear error when BLIND_INDEX_KEY is missing", async () => {
    const env = { ENCRYPTION_KEY: randomB64(32) } as Env;
    await expect(loadIdentityCipherKeys(env)).rejects.toThrow(/BLIND_INDEX_KEY/);
  });
});
