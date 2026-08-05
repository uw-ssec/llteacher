/**
 * Stateless sealed session cookie: AES-256-GCM over a small JSON payload.
 * No server-side session store -- the sealed cookie *is* the session.
 * Rotating SESSION_SECRET invalidates every active session; sessionEpoch
 * (issue #95) is the finer-grained, single-user version of that same idea --
 * rolesMiddleware compares the cookie's sessionEpoch against the live value
 * on the user row on every request, so a WorkOS deprovisioning webhook can
 * revoke one user's already-issued cookies without touching anyone else's.
 */

import { importAesGcmKey } from "./crypto/keys";

export interface SessionPayload {
  userId: string;
  workosUserId: string;
  /** WorkOS AuthKit session id (the `sid` claim on the access token JWT).
   *  Absent for sessions created before this field existed. Used solely to
   *  build the WorkOS logout URL -- never used for authorization. */
  workosSessionId?: string;
  /** Snapshot of users.session_epoch at login time (issue #95). Required,
   *  not optional -- a cookie sealed before this field existed has no valid
   *  value to fall back to, and treating "missing" as "always valid" would
   *  defeat the whole revocation mechanism. Shipping this rejects every
   *  pre-existing session once, the same one-time effect as rotating
   *  SESSION_SECRET. */
  sessionEpoch: number;
  issuedAt: number;
  expiresAt: number;
}

export const SESSION_COOKIE_NAME = "llt_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

const IV_BYTES = 12;

export function createSessionPayload(
  userId: string,
  workosUserId: string,
  sessionEpoch: number,
  now: number = Date.now(),
  workosSessionId?: string,
): SessionPayload {
  return {
    userId,
    workosUserId,
    workosSessionId,
    sessionEpoch,
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
  const payload = await decryptAndValidateShape(cookieValue, key);
  if (!payload) return null;
  if (payload.expiresAt < Date.now()) return null;
  return payload;
}

/**
 * Like `unsealSession`, but does not reject a payload solely because
 * `expiresAt` has passed -- it still requires the AES-GCM decrypt to succeed
 * and the shape to be valid, so a tampered, garbage, or wrong-key cookie is
 * still rejected. This exists ONLY for logout: the local session cookie's
 * 7-day TTL is independent of the WorkOS-side session's lifetime, so an
 * expired local cookie shouldn't stop us from recovering `workosSessionId`
 * to revoke the WorkOS session on the way out. Never use this for
 * authorization -- `authMiddleware` must keep using `unsealSession`.
 */
export async function unsealSessionIgnoringExpiry(
  cookieValue: string,
  key: CryptoKey,
): Promise<SessionPayload | null> {
  return decryptAndValidateShape(cookieValue, key);
}

async function decryptAndValidateShape(
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
      typeof payload.expiresAt !== "number" ||
      typeof payload.sessionEpoch !== "number"
    ) {
      return null;
    }
    return payload;
  } catch {
    // Tampered, malformed, or wrong key -- all treated as "no session".
    return null;
  }
}
