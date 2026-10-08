import { Hono, type Context } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import { Effect } from "effect";
import { BadRequestException, NotFoundException, OauthException, UnprocessableEntityException } from "@workos-inc/node";
import { getWorkOS } from "../../lib/workos";
import { loadIdentityCipherKeys } from "../../lib/secrets-loader";
import { IdentityCipher } from "../../lib/crypto/identity-cipher";
import { DomainAllowlistService } from "../../lib/services/DomainAllowlistService";
import { UserIdentityService, type WorkOSProfile } from "../../lib/services/UserIdentityService";
import { getAuthenticationOrgScope } from "../repositories/organizations";
import { getOrgScopesForUser } from "../repositories/users";
import { AUDIT_ACTIONS, auditBestEffort } from "../utils/audit";
import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  createSessionPayload,
  loadSessionKey,
  sealSession,
  unsealSessionIgnoringExpiry,
} from "../../lib/session";
import {
  OAUTH_TRANSACTION_COOKIE,
  OAUTH_TTL_SECONDS,
  generateState,
  generatePkceVerifier,
  computeCodeChallenge,
  parseOAuthTransaction,
  serializeOAuthTransaction,
} from "../../lib/oauth-state";
import { decodeJwt } from "jose";
import { extractSession } from "../middleware/auth";
import type { AppEnv } from "../context";
import { SERVICE_UNAVAILABLE_MESSAGE, logServerError } from "../utils/errors";
import { ExternalServiceError, RuntimeConfigError } from "../effect/errors";
import { effectHandler } from "../effect/http";
import { external, query } from "../effect/services";

/** A secret this flow needs (ENCRYPTION_KEY/BLIND_INDEX_KEY, SESSION_SECRET)
 *  is missing or unusable -- a deployment fault, typed so the callback can
 *  answer it with its own sign-in-unavailable page. */
function fromConfig<A>(run: () => Promise<A>): Effect.Effect<A, RuntimeConfigError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => new RuntimeConfigError({ problems: [cause instanceof Error ? cause.message : String(cause)] }),
  });
}

export const loginHandler = effectHandler((c) => Effect.gen(function* () {
  const secureCookie = c.env.APP_URL.startsWith("https://");

  const state = generateState();
  const verifier = generatePkceVerifier();
  const codeChallenge = yield* Effect.promise(() => computeCodeChallenge(verifier));

  const oauthCookieOptions = {
    httpOnly: true,
    secure: secureCookie,
    sameSite: "Lax" as const,
    path: "/",
    maxAge: OAUTH_TTL_SECONDS,
  };
  const returnTo = safeReturnTo(c.req.query("returnTo"));
  setCookie(c, OAUTH_TRANSACTION_COOKIE, serializeOAuthTransaction({ state, verifier, returnTo }), oauthCookieOptions);

  // Local URL construction, but it is the WorkOS client doing it: a missing
  // WORKOS_API_KEY/WORKOS_CLIENT_ID fails here, as ExternalServiceError(workos)
  // -> the generic 503.
  const authorizationUrl = yield* external("workos", "getAuthorizationUrl", async () =>
    getWorkOS(c.env.WORKOS_API_KEY).userManagement.getAuthorizationUrl({
      clientId: c.env.WORKOS_CLIENT_ID,
      redirectUri: callbackUrl(c),
      provider: "authkit",
      state,
      codeChallenge,
      codeChallengeMethod: "S256",
    }),
  );
  return c.redirect(authorizationUrl);
}));

/** WorkOS's answers to a code it will not exchange (invalid_grant, an
 *  expired or replayed code, a verifier mismatch): the sign-in attempt
 *  failed, not WorkOS. */
const CODE_REJECTIONS = [OauthException, BadRequestException, NotFoundException, UnprocessableEntityException] as const;

export const callbackHandler = effectHandler((c) => Effect.gen(function* () {
  const code = c.req.query("code");
  const returnedState = c.req.query("state");
  const transaction = parseOAuthTransaction(getCookie(c, OAUTH_TRANSACTION_COOKIE));
  const expectedState = transaction?.state;
  const verifier = transaction?.verifier;
  const returnTo = safeReturnTo(transaction?.returnTo);
  deleteCookie(c, OAUTH_TRANSACTION_COOKIE, { path: "/" });

  // Plain-text bodies (this is a browser navigation, not an API call), so
  // these are answered directly rather than as BadRequest's JSON.
  if (!code) {
    return c.text("Missing authorization code", 400);
  }
  if (!expectedState || !returnedState || returnedState !== expectedState) {
    // Missing/mismatched state means either a login-CSRF attempt or a stale
    // (expired-cookie) round trip -- both get the same generic response.
    return c.text("Invalid or expired sign-in request. Please try again.", 400);
  }

  const authenticated = yield* external(
    "workos",
    "authenticateWithCode",
    () =>
      getWorkOS(c.env.WORKOS_API_KEY).userManagement.authenticateWithCode({
        clientId: c.env.WORKOS_CLIENT_ID,
        code,
        codeVerifier: verifier,
      }),
    CODE_REJECTIONS,
  ).pipe(
    Effect.map((result) => ({ result })),
    Effect.catch((err) => {
      // A rejected code and WorkOS being unreachable both answer 401 with
      // the same retry sentence -- the browser's only move either way is to
      // sign in again. The difference is the log: a rejected code is
      // routine, an unreachable WorkOS is an operator's problem and is
      // logged as one.
      if (err instanceof ExternalServiceError) {
        logServerError("callbackHandler", err.cause, { tag: err._tag, service: err.service, operation: err.operation });
      }
      return Effect.succeed({ response: c.text("Sign-in failed. Please try again.", 401) });
    }),
  );
  if ("response" in authenticated) return authenticated.response;
  const workosUser: WorkOSProfile = authenticated.result.user;
  const workosOrganizationId: string | undefined = authenticated.result.organizationId;
  const workosSessionId = decodeSessionId(authenticated.result.accessToken);

  return yield* Effect.gen(function* () {
    const cipher = yield* fromConfig(async () => new IdentityCipher(await loadIdentityCipherKeys(c.env)));

    const allowedDomains = yield* query(
      "resolveAllowedDomains",
      (db) => DomainAllowlistService.resolveAllowedDomains(
        workosOrganizationId,
        db,
        c.env.BOOTSTRAP_ALLOWED_DOMAINS,
      ),
    );
    const domainCheck = DomainAllowlistService.validateEmailDomain(
      workosUser.email,
      allowedDomains,
    );
    if (!domainCheck.allowed) {
      const emailBlindIndex = yield* Effect.promise(() =>
        cipher.computeBlindIndex(IdentityCipher.normalizeEmail(workosUser.email)),
      );
      const grandfathered = yield* query(
        "checkGrandfathering",
        (db) => DomainAllowlistService.checkGrandfathering(workosUser.id, emailBlindIndex, db),
      );
      if (!grandfathered) {
        return c.html(disallowedDomainPage(domainCheck.reason ?? "Domain not allowed"), 403);
      }
    }

    const { userId, isNew, sessionEpoch } = yield* query(
      "createOrClaimUser",
      (db) => new UserIdentityService(cipher, db).createOrClaimUser(workosUser),
    );

    // Best-effort (#147): a login/provisioning audit gap must never block
    // sign-in. Prefer the WorkOS org the user authenticated into, then use
    // the deployment singleton for auth-only installations. The
    // course-membership-derived lookup used elsewhere cannot be used here:
    // a brand-new user has no memberships yet. No-ops only when neither a
    // matching WorkOS org nor a deployment institution exists.
    const orgScope = yield* query(
      "getAuthenticationOrgScope",
      (db) => getAuthenticationOrgScope(db, workosOrganizationId),
    );
    if (orgScope) {
      yield* query("auditBestEffort", (db) =>
        auditBestEffort(db, [orgScope], {
          actorUserId: userId,
          action: isNew ? AUDIT_ACTIONS.USER_PROVISIONED : AUDIT_ACTIONS.USER_LOGIN,
          targetType: "user",
          targetId: userId,
        }),
      );
    }

    const sessionKey = yield* fromConfig(() => loadSessionKey(c.env));
    const payload = createSessionPayload(
      userId,
      workosUser.id,
      sessionEpoch,
      undefined,
      workosSessionId,
      workosOrganizationId,
    );
    const sealed = yield* fromConfig(() => sealSession(payload, sessionKey));

    setCookie(c, SESSION_COOKIE_NAME, sealed, {
      httpOnly: true,
      secure: c.env.APP_URL.startsWith("https://"),
      sameSite: "Lax",
      path: "/",
      maxAge: SESSION_TTL_SECONDS,
    });

    return c.redirect(returnTo ?? "/");
  }).pipe(
    // DB down, misconfigured secrets, etc. -- never surface the real error
    // (e.g. a connection string) to the browser mid-login. Answered with an
    // HTML page rather than the API's JSON 503: this is a browser
    // navigation, not a fetch.
    Effect.catchTags({
      DatabaseError: (err) => signInUnavailable(c, err.cause),
      RuntimeConfigError: (err) => signInUnavailable(c, err),
    }),
  );
}));

function signInUnavailable(c: Context<AppEnv>, cause: unknown) {
  return Effect.sync(() => {
    logServerError("callbackHandler", cause);
    return c.html(signInUnavailablePage(), 503);
  });
}

export const logoutHandler = effectHandler((c) => Effect.gen(function* () {
  // A missing SESSION_SECRET (the only way these reject) is a deployment
  // fault: a defect, answered with the generic 503 as before.
  const session = yield* Effect.promise(() => extractSession(c));
  const workosSessionId = session?.workosSessionId ?? (yield* Effect.promise(() => recoverWorkosSessionId(c)));
  deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });

  // Best-effort and defensively wrapped (#147): logout must clear the
  // local cookie and still redirect to WorkOS's own sign-out even if the
  // DB is unreachable -- rolesMiddleware's PUBLIC_API_PATHS carve-out for
  // this route exists for exactly that reason. Only audited when a valid
  // (non-expired) session was present; the rare expired-cookie-but-still-
  // WorkOS-logging-out edge case recoverWorkosSessionId handles has no
  // app-side session to audit against anyway. A DatabaseError here is
  // logged and swallowed, never answered 503.
  if (session) {
    yield* Effect.gen(function* () {
      const orgScopes = yield* query("getOrgScopesForUser", (db) => getOrgScopesForUser(db, session.userId));
      yield* query("auditBestEffort", (db) =>
        auditBestEffort(db, orgScopes, {
          actorUserId: session.userId,
          action: AUDIT_ACTIONS.USER_LOGOUT,
          targetType: "user",
          targetId: session.userId,
        }),
      );
    }).pipe(Effect.catchTag("DatabaseError", (err) => Effect.sync(() => logServerError("logoutHandler", err.cause))));
  }

  if (workosSessionId) {
    const logoutUrl = yield* external("workos", "getLogoutUrl", async () =>
      getWorkOS(c.env.WORKOS_API_KEY).userManagement.getLogoutUrl({
        sessionId: workosSessionId,
        returnTo: `${c.env.APP_URL}/`,
      }),
    );
    return c.redirect(logoutUrl);
  }

  return c.redirect("/");
}));

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

function callbackUrl(c: Context<AppEnv>): string {
  return `${c.env.APP_URL}/api/auth/callback`;
}

/** Prevent an OAuth callback from becoming an open redirect. */
function safeReturnTo(value: string | undefined): string | undefined {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return undefined;
  return value;
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
export const auth = new Hono<AppEnv>();
auth.get("/login", loginHandler);
auth.get("/callback", callbackHandler);
auth.post("/logout", logoutHandler);
