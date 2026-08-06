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
    if (!(value instanceof Uint8Array)) {
      // A relational `with:` query (drizzle-orm's JSON-wrapping LATERAL
      // join) serializes bytea columns as a hex string instead of handing
      // back the driver's Buffer -- `new Uint8Array(aString)` would not
      // throw here, it silently returns a 0-length array, corrupting the
      // decrypted value with no visible error (this was the actual root
      // cause of a bug Task 19 hit and fixed locally by switching that one
      // query to a flat select+join; this guard is the durable fix so the
      // *next* `with:`-based query touching this column fails loudly here
      // instead of silently, or via a much-later confusing decryption
      // error). Use a flat select().from().innerJoin() instead of a
      // relational `with:` traversal for any query touching this column.
      throw new Error(`encryptedText.fromDriver: expected a Buffer/Uint8Array from the driver, got ${typeof value}. This almost always means a relational "with:" query wrapped this bytea column in a JSON-serializing LATERAL join -- use a flat select+join instead.`);
    }
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
    if (!(value instanceof Uint8Array)) {
      throw new Error(`blindIndex.fromDriver: expected a Buffer/Uint8Array from the driver, got ${typeof value}. This almost always means a relational "with:" query wrapped this bytea column in a JSON-serializing LATERAL join -- use a flat select+join instead.`);
    }
    return new Uint8Array(value) as BlindIndex;
  },
});
