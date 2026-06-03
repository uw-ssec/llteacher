import { beforeAll, describe, expect, it } from "vitest";

import type { Ciphertext } from "../../db/types/encrypted";

import { IdentityCipher, type IdentityCipherKeys } from "./identity-cipher";

let keys: IdentityCipherKeys;

beforeAll(async () => {
  const encryptionKey = (await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  )) as CryptoKey;
  const blindIndexKey = (await crypto.subtle.generateKey(
    { name: "HMAC", hash: "SHA-256" },
    true,
    ["sign"],
  )) as CryptoKey;
  keys = {
    encryptionKey,
    blindIndexKey,
    encryptionKeyId: "k1",
  };
});

describe("IdentityCipher.encryptString / decryptString", () => {
  it("round-trips an ASCII string", async () => {
    const cipher = new IdentityCipher(keys);
    const ct = await cipher.encryptString("cdcore@uw.edu");
    expect(await cipher.decryptString(ct)).toBe("cdcore@uw.edu");
  });

  it("round-trips an empty string", async () => {
    const cipher = new IdentityCipher(keys);
    const ct = await cipher.encryptString("");
    expect(await cipher.decryptString(ct)).toBe("");
  });

  it("round-trips unicode", async () => {
    const cipher = new IdentityCipher(keys);
    const plaintext = "学生 — naïve résumé 🎓";
    const ct = await cipher.encryptString(plaintext);
    expect(await cipher.decryptString(ct)).toBe(plaintext);
  });

  it("round-trips a long string", async () => {
    const cipher = new IdentityCipher(keys);
    const plaintext = "x".repeat(10_000);
    const ct = await cipher.encryptString(plaintext);
    expect(await cipher.decryptString(ct)).toBe(plaintext);
  });

  it("produces different ciphertexts for the same plaintext (random IV)", async () => {
    const cipher = new IdentityCipher(keys);
    const plaintext = "cdcore@uw.edu";
    const ct1 = await cipher.encryptString(plaintext);
    const ct2 = await cipher.encryptString(plaintext);
    expect(Buffer.from(ct1).equals(Buffer.from(ct2))).toBe(false);
    expect(await cipher.decryptString(ct1)).toBe(plaintext);
    expect(await cipher.decryptString(ct2)).toBe(plaintext);
  });

  it("decrypts ciphertext produced by a sibling cipher with the same keys", async () => {
    const writer = new IdentityCipher(keys);
    const reader = new IdentityCipher(keys);
    const ct = await writer.encryptString("cdcore@uw.edu");
    expect(await reader.decryptString(ct)).toBe("cdcore@uw.edu");
  });

  it("rejects ciphertext with an unknown key id", async () => {
    const cipher = new IdentityCipher(keys);
    const ct = await cipher.encryptString("cdcore@uw.edu");
    ct[1] = ct[1] ^ 0xff; // flip a bit in the key id field
    await expect(cipher.decryptString(ct)).rejects.toThrow(/unknown key id/i);
  });

  it("rejects ciphertext with an unsupported version byte", async () => {
    const cipher = new IdentityCipher(keys);
    const ct = await cipher.encryptString("cdcore@uw.edu");
    ct[0] = 0xff;
    await expect(cipher.decryptString(ct)).rejects.toThrow(/version/i);
  });

  it("rejects ciphertext shorter than the envelope header", async () => {
    const cipher = new IdentityCipher(keys);
    const truncated = new Uint8Array(10) as Ciphertext;
    await expect(cipher.decryptString(truncated)).rejects.toThrow(
      /shorter than envelope/i,
    );
  });

  it("rejects ciphertext whose AES-GCM auth tag has been tampered with", async () => {
    const cipher = new IdentityCipher(keys);
    const ct = await cipher.encryptString("cdcore@uw.edu");
    ct[ct.length - 1] = ct[ct.length - 1] ^ 0xff;
    await expect(cipher.decryptString(ct)).rejects.toThrow();
  });

  it("rejects ciphertext when decrypted with a different encryption key but same key id", async () => {
    const otherEncryptionKey = (await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    )) as CryptoKey;
    const writer = new IdentityCipher(keys);
    const reader = new IdentityCipher({
      ...keys,
      encryptionKey: otherEncryptionKey,
    });
    const ct = await writer.encryptString("cdcore@uw.edu");
    await expect(reader.decryptString(ct)).rejects.toThrow();
  });
});

describe("IdentityCipher.computeBlindIndex", () => {
  it("is deterministic for the same input", async () => {
    const cipher = new IdentityCipher(keys);
    const a = await cipher.computeBlindIndex("cdcore");
    const b = await cipher.computeBlindIndex("cdcore");
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("produces different output for different inputs", async () => {
    const cipher = new IdentityCipher(keys);
    const a = await cipher.computeBlindIndex("cdcore");
    const b = await cipher.computeBlindIndex("alice");
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it("uses the blind-index key (separation from encryption key)", async () => {
    const otherBlindKey = (await crypto.subtle.generateKey(
      { name: "HMAC", hash: "SHA-256" },
      true,
      ["sign"],
    )) as CryptoKey;
    const cipherA = new IdentityCipher(keys);
    const cipherB = new IdentityCipher({
      ...keys,
      blindIndexKey: otherBlindKey,
    });
    const a = await cipherA.computeBlindIndex("cdcore");
    const b = await cipherB.computeBlindIndex("cdcore");
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it("produces a 32-byte output (HMAC-SHA256)", async () => {
    const cipher = new IdentityCipher(keys);
    const out = await cipher.computeBlindIndex("anything");
    expect(out.byteLength).toBe(32);
  });
});

describe("IdentityCipher normalizers", () => {
  it("normalizeEmail trims and lowercases", () => {
    expect(IdentityCipher.normalizeEmail("  CDCore@UW.edu  ")).toBe(
      "cdcore@uw.edu",
    );
  });

  it("normalizeNetid trims and lowercases", () => {
    expect(IdentityCipher.normalizeNetid("  CDCore  ")).toBe("cdcore");
  });

  it("blind index over normalized values is stable across casings and whitespace", async () => {
    const cipher = new IdentityCipher(keys);
    const a = await cipher.computeBlindIndex(
      IdentityCipher.normalizeEmail("CDCore@UW.edu"),
    );
    const b = await cipher.computeBlindIndex(
      IdentityCipher.normalizeEmail("  cdcore@uw.edu  "),
    );
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});

describe("IdentityCipher constructor", () => {
  it("rejects an empty key id", () => {
    expect(
      () => new IdentityCipher({ ...keys, encryptionKeyId: "" }),
    ).toThrow(/encryptionKeyId/);
  });

  it("rejects an oversized key id (>16 bytes)", () => {
    expect(
      () =>
        new IdentityCipher({
          ...keys,
          encryptionKeyId: "x".repeat(17),
        }),
    ).toThrow(/encryptionKeyId/);
  });

  it("accepts a 16-byte key id at the boundary", () => {
    expect(
      () =>
        new IdentityCipher({
          ...keys,
          encryptionKeyId: "x".repeat(16),
        }),
    ).not.toThrow();
  });
});
