import { Hono, type Context } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import { getWorkOS } from "../../lib/workos";
import { makeDb } from "../../db/client";
import { loadIdentityCipherKeys } from "../../lib/secrets-loader";
import { IdentityCipher } from "../../lib/crypto/identity-cipher";
import { DomainAllowlistService } from "../../lib/services/DomainAllowlistService";
import { UserIdentityService } from "../../lib/services/UserIdentityService";
import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  createSessionPayload,
  loadSessionKey,
  sealSession,
  unsealSessionIgnoringExpiry,
} from "../../lib/session";
import {
  OAUTH_STATE_COOKIE,
  OAUTH_VERIFIER_COOKIE,
  OAUTH_TTL_SECONDS,
  generateState,
  generatePkceVerifier,
  computeCodeChallenge,
} from "../../lib/oauth-state";
import { decodeJwt } from "jose";
import { extractSession } from "../middleware/auth";
import type { AppEnv } from "../context";
import { SERVICE_UNAVAILABLE_MESSAGE, logServerError } from "../utils/errors";

// TODO(#11): move to Organization.allowedDomains once multi-org provisioning
// lands; v0 is single-tenant UW.
const DEFAULT_ALLOWED_DOMAINS = ["uw.edu"];

export async function loginHandler(c: Context<{ Bindings: Env }>) {
  const workos = getWorkOS(c.env.WORKOS_API_KEY);
  const secureCookie = c.req.url.startsWith("https://");

  const state = generateState();
  const verifier = generatePkceVerifier();
  const codeChallenge = await computeCodeChallenge(verifier);

  const oauthCookieOptions = {
    httpOnly: true,
    secure: secureCookie,
    sameSite: "Lax" as const,
    path: "/",
    maxAge: OAUTH_TTL_SECONDS,
  };
  setCookie(c, OAUTH_STATE_COOKIE, state, oauthCookieOptions);
  setCookie(c, OAUTH_VERIFIER_COOKIE, verifier, oauthCookieOptions);

  const authorizationUrl = workos.userManagement.getAuthorizationUrl({
    clientId: c.env.WORKOS_CLIENT_ID,
    redirectUri: callbackUrl(c),
    provider: "authkit",
    state,
    codeChallenge,
    codeChallengeMethod: "S256",
  });
  return c.redirect(authorizationUrl);
}

export async function callbackHandler(c: Context<{ Bindings: Env }>) {
  const code = c.req.query("code");
  const returnedState = c.req.query("state");
  const expectedState = getCookie(c, OAUTH_STATE_COOKIE);
  const verifier = getCookie(c, OAUTH_VERIFIER_COOKIE);
  deleteCookie(c, OAUTH_STATE_COOKIE, { path: "/" });
  deleteCookie(c, OAUTH_VERIFIER_COOKIE, { path: "/" });

  if (!code) {
    return c.text("Missing authorization code", 400);
  }
  if (!expectedState || !returnedState || returnedState !== expectedState) {
    // Missing/mismatched state means either a login-CSRF attempt or a stale
    // (expired-cookie) round trip -- both get the same generic response.
    return c.text("Invalid or expired sign-in request. Please try again.", 400);
  }

  const workos = getWorkOS(c.env.WORKOS_API_KEY);
  let workosUser: { id: string; email: string; firstName?: string | null };
  let workosSessionId: string | undefined;
  try {
    const result = await workos.userManagement.authenticateWithCode({
      clientId: c.env.WORKOS_CLIENT_ID,
      code,
      codeVerifier: verifier,
    });
    workosUser = result.user;
    workosSessionId = decodeSessionId(result.accessToken);
  } catch {
    return c.text("Sign-in failed. Please try again.", 401);
  }

  try {
    const cipher = new IdentityCipher(await loadIdentityCipherKeys(c.env));
    const db = makeDb(c.env.DATABASE_URL);

    const domainCheck = DomainAllowlistService.validateEmailDomain(
      workosUser.email,
      DEFAULT_ALLOWED_DOMAINS,
    );
    if (!domainCheck.allowed) {
      const emailBlindIndex = await cipher.computeBlindIndex(
        IdentityCipher.normalizeEmail(workosUser.email),
      );
      const grandfathered = await DomainAllowlistService.checkGrandfathering(emailBlindIndex, db);
      if (!grandfathered) {
        return c.html(disallowedDomainPage(domainCheck.reason ?? "Domain not allowed"), 403);
      }
    }

    const { userId } = await new UserIdentityService(cipher, db).createOrClaimUser(workosUser);

    const sessionKey = await loadSessionKey(c.env);
    const payload = createSessionPayload(userId, workosUser.id, undefined, workosSessionId);
    const sealed = await sealSession(payload, sessionKey);

    setCookie(c, SESSION_COOKIE_NAME, sealed, {
      httpOnly: true,
      secure: c.req.url.startsWith("https://"),
      sameSite: "Lax",
      path: "/",
      maxAge: SESSION_TTL_SECONDS,
    });

    return c.redirect("/");
  } catch (err) {
    // DB down, misconfigured secrets, etc. -- never surface the real error
    // (e.g. a connection string) to the browser mid-login.
    logServerError("callbackHandler", err);
    return c.html(signInUnavailablePage(), 503);
  }
}

export async function logoutHandler(c: Context<AppEnv>) {
  const session = await extractSession(c);
  const workosSessionId = session?.workosSessionId ?? (await recoverWorkosSessionId(c));
  deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });

  if (workosSessionId) {
    const workos = getWorkOS(c.env.WORKOS_API_KEY);
    const origin = c.req.header("origin") ?? new URL(c.req.url).origin;
    const logoutUrl = workos.userManagement.getLogoutUrl({
      sessionId: workosSessionId,
      returnTo: `${origin}/`,
    });
    return c.redirect(logoutUrl);
  }

  return c.redirect("/");
}

/**
 * Fallback for logout only: `extractSession` (via `unsealSession`) returns
 * null for an expired local session cookie, but the WorkOS-side session may
 * still be alive -- its lifetime isn't tied to our 7-day local cookie TTL.
 * Re-reads the raw cookie and decrypts it while ignoring expiry, purely to
 * recover `workosSessionId` so we can still revoke the WorkOS session on the
 * way out. A tampered/garbage/wrong-key cookie still yields undefined here
 * (unsealSessionIgnoringExpiry only skips the expiry check, not decryption).
 */
async function recoverWorkosSessionId(c: Context<AppEnv>): Promise<string | undefined> {
  const cookieValue = getCookie(c, SESSION_COOKIE_NAME);
  if (!cookieValue) return undefined;
  const key = await loadSessionKey(c.env);
  const payload = await unsealSessionIgnoringExpiry(cookieValue, key);
  return payload?.workosSessionId;
}

function decodeSessionId(accessToken: string): string | undefined {
  try {
    const claims = decodeJwt(accessToken);
    return typeof claims.sid === "string" ? claims.sid : undefined;
  } catch {
    return undefined;
  }
}

function callbackUrl(c: Context<{ Bindings: Env }>): string {
  const origin = c.req.header("origin") ?? new URL(c.req.url).origin;
  return `${origin}/api/auth/callback`;
}

function disallowedDomainPage(reason: string): string {
  return errorPage("Access Denied", reason);
}

function signInUnavailablePage(): string {
  return errorPage("Sign-in failed", SERVICE_UNAVAILABLE_MESSAGE);
}

function errorPage(title: string, message: string): string {
  return `<!doctype html><html><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Sub-app preserved for direct unit testing; production routing happens via
// app.get/post("/api/auth/...", ...) in server/index.ts (see hello.ts).
export const auth = new Hono<{ Bindings: Env }>();
auth.get("/login", loginHandler);
auth.get("/callback", callbackHandler);
auth.post("/logout", logoutHandler);
