/**
 * Stateless sealed session cookie: AES-256-GCM over a small JSON payload.
 * No server-side session store -- the sealed cookie *is* the session.
 * Rotating SESSION_SECRET invalidates every active session (acceptable
 * per issue #8; a revocation mechanism for single-user logout-everywhere
 * is issue #95's concern).
 */

import { importAesGcmKey } from "./crypto/keys";

export interface SessionPayload {
  userId: string;
  workosUserId: string;
  issuedAt: number;
  expiresAt: number;
}

export const SESSION_COOKIE_NAME = "llt_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

const IV_BYTES = 12;

export function createSessionPayload(
  userId: string,
  workosUserId: string,
  now: number = Date.now(),
): SessionPayload {
  return {
    userId,
    workosUserId,
    issuedAt: now,
    expiresAt: now + SESSION_TTL_SECONDS * 1000,
  };
}

export async function loadSessionKey(env: Env): Promise<CryptoKey> {
  const secret = env.SESSION_SECRET;
  if (!secret) {
    throw new Error(
      "SESSION_SECRET must be set (apps/web/.dev.vars locally; the deployed secrets store in prod).",
    );
  }
  return importAesGcmKey(secret);
}

export async function sealSession(payload: SessionPayload, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const data = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data),
  );
  const combined = new Uint8Array(iv.length + ciphertext.length);
  combined.set(iv, 0);
  combined.set(ciphertext, iv.length);
  return Buffer.from(combined).toString("base64url");
}

export async function unsealSession(
  cookieValue: string,
  key: CryptoKey,
): Promise<SessionPayload | null> {
  try {
    const combined = new Uint8Array(Buffer.from(cookieValue, "base64url"));
    if (combined.length <= IV_BYTES) return null;
    const iv = combined.subarray(0, IV_BYTES);
    const ciphertext = combined.subarray(IV_BYTES);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    const payload = JSON.parse(new TextDecoder().decode(plaintext)) as SessionPayload;
    if (
      typeof payload.userId !== "string" ||
      typeof payload.workosUserId !== "string" ||
      typeof payload.expiresAt !== "number"
    ) {
      return null;
    }
    if (payload.expiresAt < Date.now()) return null;
    return payload;
  } catch {
    // Tampered, malformed, or wrong key -- all treated as "no session".
    return null;
  }
}
