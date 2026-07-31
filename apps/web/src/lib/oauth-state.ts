/**
 * Short-lived cookies binding a WorkOS AuthKit authorization request to the
 * browser that started it: a random `state` value (login-CSRF defense) and a
 * PKCE code_verifier/code_challenge pair (authorization-code-injection
 * defense). Both cookies are read once and cleared in the callback handler,
 * regardless of outcome. See OAuth 2.0 Security Best Current Practice
 * (RFC 9700) SS2.1 and SS4.7.1, and PKCE (RFC 7636).
 */

export const OAUTH_STATE_COOKIE = "llt_oauth_state";
export const OAUTH_VERIFIER_COOKIE = "llt_oauth_verifier";
/** Covers the AuthKit hosted-UI round trip; not the session lifetime. */
export const OAUTH_TTL_SECONDS = 600;

export function generateState(): string {
  return randomUrlSafeString(32);
}

export function generatePkceVerifier(): string {
  // RFC 7636 SS4.1: 43-128 characters from [A-Z a-z 0-9 - . _ ~]. 32 random
  // bytes, base64url-encoded, is 43 characters -- the minimum of that range
  // with 256 bits of entropy.
  return randomUrlSafeString(32);
}

export async function computeCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(digest));
}

function randomUrlSafeString(byteLength: number): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(byteLength)));
}

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}
