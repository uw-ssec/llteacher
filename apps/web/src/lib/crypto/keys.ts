/** Imports a base64-encoded raw key as an AES-256-GCM CryptoKey. Shared by
 *  session.ts (SESSION_SECRET) and secrets-loader.ts (ENCRYPTION_KEY) --
 *  same primitive, different keys. */
export async function importAesGcmKey(base64Key: string): Promise<CryptoKey> {
  const raw = new Uint8Array(Buffer.from(base64Key, "base64"));
  if (raw.byteLength !== 32) {
    throw new Error(
      `AES-256-GCM key must decode to exactly 32 bytes (got ${raw.byteLength}). ` +
        "Generate one with: openssl rand -base64 32",
    );
  }
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
