/** Imports a base64-encoded raw key as an AES-256-GCM CryptoKey. Shared by
 *  session.ts (SESSION_SECRET) and secrets-loader.ts (ENCRYPTION_KEY) --
 *  same primitive, different keys. */
export async function importAesGcmKey(base64Key: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new Uint8Array(Buffer.from(base64Key, "base64")),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}
