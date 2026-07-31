import { describe, it, expect } from "vitest";
import { importAesGcmKey } from "./keys";

function randomB64(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64");
}

describe("importAesGcmKey", () => {
  it("imports a valid 32-byte (AES-256) key", async () => {
    const key = await importAesGcmKey(randomB64(32));
    expect(key.algorithm).toEqual(expect.objectContaining({ name: "AES-GCM" }));
  });

  it("rejects a 16-byte (AES-128) key", async () => {
    await expect(importAesGcmKey(randomB64(16))).rejects.toThrow(/32 bytes/);
  });

  it("rejects a 24-byte (AES-192) key", async () => {
    await expect(importAesGcmKey(randomB64(24))).rejects.toThrow(/32 bytes/);
  });

  it("rejects an empty key", async () => {
    await expect(importAesGcmKey("")).rejects.toThrow(/32 bytes/);
  });
});
