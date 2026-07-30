/**
 * Branded byte-typed Drizzle column helpers for at-rest encryption of PII.
 *
 * Two column types are exposed:
 *   - encryptedText(name): AES-256-GCM ciphertext envelope, stored as bytea.
 *   - blindIndex(name):    HMAC-SHA256 of the normalized plaintext, stored as
 *                          bytea. Used as a deterministic equality-lookup token
 *                          for encrypted fields.
 *
 * The branded TS types (Ciphertext, BlindIndex) prevent accidental mixing of
 * encrypted bytes with plaintext strings, or of ciphertext bytes with blind
 * indexes, at compile time.
 *
 * The actual encryption/HMAC happens in lib/crypto/identity-cipher.ts. The
 * column types here only define the SQL shape and the driver <-> TS coercion;
 * they do not perform crypto.
 */

import { customType } from "drizzle-orm/pg-core";

declare const CiphertextBrand: unique symbol;
declare const BlindIndexBrand: unique symbol;

export type Ciphertext = Uint8Array & { readonly [CiphertextBrand]: true };
export type BlindIndex = Uint8Array & { readonly [BlindIndexBrand]: true };

export const encryptedText = customType<{
  data: Ciphertext;
  driverData: Buffer;
}>({
  dataType() {
    return "bytea";
  },
  toDriver(value): Buffer {
    return Buffer.from(value);
  },
  fromDriver(value): Ciphertext {
    return new Uint8Array(value) as Ciphertext;
  },
});

export const blindIndex = customType<{
  data: BlindIndex;
  driverData: Buffer;
}>({
  dataType() {
    return "bytea";
  },
  toDriver(value): Buffer {
    return Buffer.from(value);
  },
  fromDriver(value): BlindIndex {
    return new Uint8Array(value) as BlindIndex;
  },
});
