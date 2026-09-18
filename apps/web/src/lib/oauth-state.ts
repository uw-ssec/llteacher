/**
 * Short-lived cookies binding a WorkOS AuthKit authorization request to the
 * browser that started it: a random `state` value (login-CSRF defense) and a
 * PKCE code_verifier/code_challenge pair (authorization-code-injection
 * defense). Both cookies are read once and cleared in the callback handler,
 * regardless of outcome. See OAuth 2.0 Security Best Current Practice
 * (RFC 9700) SS2.1 and SS4.7.1, and PKCE (RFC 7636).
 */

/**
 * All short-lived AuthKit bindings live in one cookie. Some local ALB
 * emulators preserve only one Set-Cookie header, so separate state, verifier,
 * and return-path cookies would lose CSRF or PKCE protection in that path.
 */
export const OAUTH_TRANSACTION_COOKIE = "llt_oauth_transaction";
/** Covers the AuthKit hosted-UI round trip; not the session lifetime. */
export const OAUTH_TTL_SECONDS = 600;

export interface OAuthTransaction {
  state: string;
  verifier: string;
  returnTo?: string;
}

export function serializeOAuthTransaction(transaction: OAuthTransaction): string {
  return Buffer.from(JSON.stringify(transaction)).toString("base64url");
}

/** Fails closed when a cookie is malformed or was not created by this flow. */
export function parseOAuthTransaction(value: string | undefined): OAuthTransaction | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof parsed.state !== "string" || typeof parsed.verifier !== "string") return undefined;
    if (parsed.returnTo !== undefined && typeof parsed.returnTo !== "string") return undefined;
    return {
      state: parsed.state,
      verifier: parsed.verifier,
      ...(typeof parsed.returnTo === "string" ? { returnTo: parsed.returnTo } : {}),
    };
  } catch {
    return undefined;
  }
}

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
