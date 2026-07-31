import type { IdentityCipherKeys } from "./crypto/identity-cipher";

/** v0 ships a single active encryption key id. Rotation tooling lands
 *  when key rotation is actually needed (see identity-cipher.ts header). */
const ACTIVE_KEY_ID = "k1";

export async function loadIdentityCipherKeys(env: Env): Promise<IdentityCipherKeys> {
  const encryptionKeyB64 = env.ENCRYPTION_KEY;
  const blindIndexKeyB64 = env.BLIND_INDEX_KEY;

  if (!encryptionKeyB64) {
    throw new Error(
      "ENCRYPTION_KEY must be set (apps/web/.dev.vars locally; the deployed secrets store in prod).",
    );
  }
  if (!blindIndexKeyB64) {
    throw new Error(
      "BLIND_INDEX_KEY must be set (apps/web/.dev.vars locally; the deployed secrets store in prod).",
    );
  }

  const encryptionKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(Buffer.from(encryptionKeyB64, "base64")),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
  const blindIndexKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(Buffer.from(blindIndexKeyB64, "base64")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  return { encryptionKey, blindIndexKey, encryptionKeyId: ACTIVE_KEY_ID };
}
