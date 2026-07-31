import { Hono, type Context } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
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
} from "../../lib/session";
import { SERVICE_UNAVAILABLE_MESSAGE, logServerError } from "../utils/errors";

// TODO(#11): move to Organization.allowedDomains once multi-org provisioning
// lands; v0 is single-tenant UW.
const DEFAULT_ALLOWED_DOMAINS = ["uw.edu"];

export async function loginHandler(c: Context<{ Bindings: Env }>) {
  const workos = getWorkOS(c.env.WORKOS_API_KEY);
  const authorizationUrl = workos.userManagement.getAuthorizationUrl({
    clientId: c.env.WORKOS_CLIENT_ID,
    redirectUri: callbackUrl(c),
    provider: "authkit",
  });
  return c.redirect(authorizationUrl);
}

export async function callbackHandler(c: Context<{ Bindings: Env }>) {
  const code = c.req.query("code");
  if (!code) {
    return c.text("Missing authorization code", 400);
  }

  const workos = getWorkOS(c.env.WORKOS_API_KEY);
  let workosUser: { id: string; email: string; firstName?: string | null };
  try {
    const result = await workos.userManagement.authenticateWithCode({
      clientId: c.env.WORKOS_CLIENT_ID,
      code,
    });
    workosUser = result.user;
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
    const payload = createSessionPayload(userId, workosUser.id);
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

export async function logoutHandler(c: Context<{ Bindings: Env }>) {
  deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });
  return c.redirect("/");
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
