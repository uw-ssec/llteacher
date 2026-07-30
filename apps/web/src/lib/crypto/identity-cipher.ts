/**
 * Identity cipher: AES-256-GCM encryption + HMAC-SHA256 blind indexes for PII
 * stored in the application database.
 *
 * Threat model:
 *   - Defends against pure database exfiltration (Neon compromise, leaked
 *     SQL dump). An attacker with only the DB sees ciphertext and blind
 *     indexes -- not names, emails, or NetIDs.
 *   - Does NOT defend against compromise of the Worker runtime, which has the
 *     decryption key resident in memory for the lifetime of the isolate.
 *   - Does NOT change FERPA/GDPR legal status: encrypted PII is still PII
 *     because we hold the keys. See docs/architecture/multi-tenant-data-model.md.
 *
 * Keys (loaded once at Worker startup from Cloudflare Secrets Store):
 *   - encryptionKey: AES-256-GCM. Encrypts and decrypts PII fields.
 *   - blindIndexKey: HMAC-SHA256. Computes deterministic lookup tokens for
 *     encrypted fields. MUST be a different key from encryptionKey -- reusing
 *     the same key materially weakens both primitives.
 *
 * Ciphertext envelope (binary layout):
 *   [1 byte version=0x01][16 bytes keyId][12 bytes IV][N bytes AES-GCM output]
 *
 * The keyId is written into every ciphertext so the encryption key can be
 * rotated without re-encrypting existing rows. v0 ships with a single active
 * key; rotation tooling lands when we actually need to rotate.
 *
 * Blind indexes do not embed a key id -- rotating the blind index key requires
 * re-hashing every row that uses it. Plan for that explicitly when it happens.
 */

import type { BlindIndex, Ciphertext } from "../../db/types/encrypted";

const ENVELOPE_VERSION = 0x01;
const KEY_ID_BYTES = 16;
const IV_BYTES = 12;
const HEADER_BYTES = 1 + KEY_ID_BYTES + IV_BYTES;

export interface IdentityCipherKeys {
  encryptionKey: CryptoKey;
  blindIndexKey: CryptoKey;
  /** Up to 16 ASCII bytes; e.g. "k1" or "2026-06". */
  encryptionKeyId: string;
}

export class IdentityCipher {
  constructor(private readonly keys: IdentityCipherKeys) {
    const idBytes = new TextEncoder().encode(keys.encryptionKeyId);
    if (idBytes.byteLength === 0 || idBytes.byteLength > KEY_ID_BYTES) {
      throw new Error(
        `encryptionKeyId must be 1..${KEY_ID_BYTES} bytes (got ${idBytes.byteLength})`,
      );
    }
  }

  async encryptString(plaintext: string): Promise<Ciphertext> {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const data = new TextEncoder().encode(plaintext);
    const payload = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      this.keys.encryptionKey,
      data,
    );
    return wrap(this.keys.encryptionKeyId, iv, new Uint8Array(payload));
  }

  async decryptString(ciphertext: Ciphertext): Promise<string> {
    const { iv, payload, keyId } = unwrap(ciphertext);
    if (keyId !== this.keys.encryptionKeyId) {
      // v0: single active key. When rotation lands, look up the right key here.
      throw new Error(`Cannot decrypt: unknown key id "${keyId}"`);
    }
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      this.keys.encryptionKey,
      payload,
    );
    return new TextDecoder().decode(plaintext);
  }

  async computeBlindIndex(normalized: string): Promise<BlindIndex> {
    const data = new TextEncoder().encode(normalized);
    const sig = await crypto.subtle.sign("HMAC", this.keys.blindIndexKey, data);
    return new Uint8Array(sig) as BlindIndex;
  }

  static normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  static normalizeNetid(netid: string): string {
    return netid.trim().toLowerCase();
  }
}

function wrap(
  keyId: string,
  iv: Uint8Array,
  payload: Uint8Array,
): Ciphertext {
  const out = new Uint8Array(HEADER_BYTES + payload.byteLength);
  out[0] = ENVELOPE_VERSION;
  const keyIdBytes = new TextEncoder().encode(keyId);
  out.set(keyIdBytes, 1); // remaining bytes are zero-padded
  out.set(iv, 1 + KEY_ID_BYTES);
  out.set(payload, HEADER_BYTES);
  return out as Ciphertext;
}

function unwrap(ciphertext: Ciphertext): {
  iv: Uint8Array<ArrayBuffer>;
  payload: Uint8Array<ArrayBuffer>;
  keyId: string;
} {
  if (ciphertext.length < HEADER_BYTES) {
    throw new Error("Ciphertext shorter than envelope header");
  }
  if (ciphertext[0] !== ENVELOPE_VERSION) {
    throw new Error(`Unsupported ciphertext version: ${ciphertext[0]}`);
  }
  // Allocate fresh ArrayBuffer-backed Uint8Arrays so the result satisfies
  // BufferSource (WebCrypto requires Uint8Array<ArrayBuffer>; subarray/slice
  // on Ciphertext propagates ArrayBufferLike, which doesn't satisfy it).
  const keyIdRaw = new Uint8Array(KEY_ID_BYTES);
  keyIdRaw.set(ciphertext.subarray(1, 1 + KEY_ID_BYTES));
  let keyIdEnd = keyIdRaw.length;
  while (keyIdEnd > 0 && keyIdRaw[keyIdEnd - 1] === 0) {
    keyIdEnd--;
  }
  const keyId = new TextDecoder().decode(keyIdRaw.subarray(0, keyIdEnd));

  const iv = new Uint8Array(IV_BYTES);
  iv.set(ciphertext.subarray(1 + KEY_ID_BYTES, HEADER_BYTES));

  const payloadLen = ciphertext.length - HEADER_BYTES;
  const payload = new Uint8Array(payloadLen);
  payload.set(ciphertext.subarray(HEADER_BYTES));

  return { iv, payload, keyId };
}
