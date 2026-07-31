import { describe, it, expect, vi, beforeEach } from "vitest";
import { auth } from "./auth";
import { SESSION_COOKIE_NAME } from "../../lib/session";
import { OAUTH_STATE_COOKIE, OAUTH_VERIFIER_COOKIE } from "../../lib/oauth-state";

const TEST_ENV = {
  SESSION_SECRET: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
  ENCRYPTION_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
  BLIND_INDEX_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
  WORKOS_API_KEY: "sk_test_x",
  WORKOS_CLIENT_ID: "client_x",
  DATABASE_URL: "ignored",
} as Env;

const authenticateWithCode = vi.fn();
const getAuthorizationUrl = vi.fn(() => "https://api.workos.com/sso/authorize?fake=1");
const getLogoutUrl = vi.fn(() => "https://api.workos.com/sso/logout?fake=1");

vi.mock("../../lib/workos", () => ({
  getWorkOS: () => ({
    userManagement: { authenticateWithCode, getAuthorizationUrl, getLogoutUrl },
  }),
}));

type InsertImpl = (...args: unknown[]) => unknown;

const defaultInsertImpl: InsertImpl = () => ({
  values: () => ({ returning: async () => [{ id: "new-user-1" }] }),
});
let dbInsertImpl: InsertImpl = defaultInsertImpl;
let dbFindFirstImpl: (...args: unknown[]) => Promise<unknown> = async () => undefined;

vi.mock("../../db/client", () => ({
  makeDb: () => ({
    query: {
      users: { findFirst: (...args: unknown[]) => dbFindFirstImpl(...args) },
      organizations: { findFirst: async () => undefined },
    },
    insert: (...args: unknown[]) => dbInsertImpl(...args),
  }),
}));

beforeEach(() => {
  authenticateWithCode.mockReset();
  getAuthorizationUrl.mockClear();
  getLogoutUrl.mockClear();
  dbInsertImpl = defaultInsertImpl;
  dbFindFirstImpl = async () => undefined;
});

/** Simulates a real browser: hits /login to capture the state+PKCE cookies
 *  WorkOS would echo back, then builds the /callback request those cookies
 *  and a matching `state` query param. */
async function loginThenBuildCallbackRequest(codeQueryString = "code=good") {
  const loginRes = await auth.request("/login", {}, TEST_ENV);
  const setCookieHeader = loginRes.headers.get("set-cookie") ?? "";
  const state = extractCookieValue(setCookieHeader, OAUTH_STATE_COOKIE);
  const cookieHeader = setCookieHeader
    .split(", ")
    .map((c) => c.split(";")[0])
    .join("; ");
  return {
    path: `/callback?${codeQueryString}&state=${state}`,
    headers: { cookie: cookieHeader },
  };
}

function extractCookieValue(setCookieHeader: string, name: string): string {
  const match = new RegExp(`${name}=([^;,]+)`).exec(setCookieHeader);
  if (!match) throw new Error(`cookie ${name} not found in ${setCookieHeader}`);
  return match[1];
}

describe("GET /login", () => {
  it("redirects to the WorkOS authorization URL", async () => {
    const res = await auth.request("/login", {}, TEST_ENV);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("workos.com");
  });

  it("passes state and a PKCE S256 code challenge to WorkOS", async () => {
    await auth.request("/login", {}, TEST_ENV);
    expect(getAuthorizationUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        state: expect.any(String),
        codeChallenge: expect.any(String),
        codeChallengeMethod: "S256",
      }),
    );
  });

  it("sets HttpOnly state and PKCE verifier cookies", async () => {
    const res = await auth.request("/login", {}, TEST_ENV);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(OAUTH_STATE_COOKIE);
    expect(setCookie).toContain(OAUTH_VERIFIER_COOKIE);
    expect(setCookie).toContain("HttpOnly");
  });
});

describe("GET /callback", () => {
  it("returns 400 when there is no state cookie at all (direct hit, no prior /login)", async () => {
    const res = await auth.request("/callback?code=good&state=whatever", {}, TEST_ENV);
    expect(res.status).toBe(400);
    expect(authenticateWithCode).not.toHaveBeenCalled();
  });

  it("returns 400 when the returned state does not match the cookie", async () => {
    const { headers } = await loginThenBuildCallbackRequest();
    const res = await auth.request(
      "/callback?code=good&state=tampered-value",
      { headers },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect(authenticateWithCode).not.toHaveBeenCalled();
  });

  it("returns 400 when the code query param is missing", async () => {
    const { path, headers } = await loginThenBuildCallbackRequest("");
    const res = await auth.request(path.replace(/\?.*/, "?state=x"), { headers }, TEST_ENV);
    expect(res.status).toBe(400);
  });

  it("returns 401 when WorkOS rejects the code", async () => {
    authenticateWithCode.mockRejectedValue(new Error("invalid_grant"));
    const { path, headers } = await loginThenBuildCallbackRequest("code=bad");
    const res = await auth.request(path, { headers }, TEST_ENV);
    expect(res.status).toBe(401);
  });

  it("forwards the PKCE code_verifier from the cookie to authenticateWithCode", async () => {
    authenticateWithCode.mockResolvedValue({
      user: { id: "workos_1", email: "cdcore@uw.edu", firstName: "Cordero" },
      accessToken: fakeAccessToken(),
    });
    const { path, headers } = await loginThenBuildCallbackRequest();
    await auth.request(path, { headers }, TEST_ENV);
    expect(authenticateWithCode).toHaveBeenCalledWith(
      expect.objectContaining({ code: "good", codeVerifier: expect.any(String) }),
    );
  });

  it("rejects a disallowed email domain with 403 and sets no session cookie", async () => {
    authenticateWithCode.mockResolvedValue({
      user: { id: "workos_1", email: "cdcore@gmail.com", firstName: "Cordero" },
      accessToken: fakeAccessToken(),
    });
    const { path, headers } = await loginThenBuildCallbackRequest();
    const res = await auth.request(path, { headers }, TEST_ENV);
    expect(res.status).toBe(403);
    // The oauth state/verifier cookies are cleared on every path (see the
    // "clears the oauth state/verifier cookies" test below); what matters
    // here is that no session cookie is issued for a disallowed domain.
    expect(res.headers.get("set-cookie")).not.toContain(SESSION_COOKIE_NAME);
  });

  it("happy path: sets a session cookie and redirects to /", async () => {
    authenticateWithCode.mockResolvedValue({
      user: { id: "workos_1", email: "cdcore@uw.edu", firstName: "Cordero" },
      accessToken: fakeAccessToken(),
    });
    const { path, headers } = await loginThenBuildCallbackRequest();
    const res = await auth.request(path, { headers }, TEST_ENV);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(SESSION_COOKIE_NAME);
    expect(setCookie).toContain("HttpOnly");
  });

  it("clears the oauth state/verifier cookies after use, on both success and failure", async () => {
    authenticateWithCode.mockResolvedValue({
      user: { id: "workos_1", email: "cdcore@uw.edu", firstName: "Cordero" },
      accessToken: fakeAccessToken(),
    });
    const { path, headers } = await loginThenBuildCallbackRequest();
    const res = await auth.request(path, { headers }, TEST_ENV);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${OAUTH_STATE_COOKIE}=;`);
    expect(setCookie).toContain(`${OAUTH_VERIFIER_COOKIE}=;`);
  });

  it("shows a generic error page (and logs the real error) when provisioning fails", async () => {
    authenticateWithCode.mockResolvedValue({
      user: { id: "workos_1", email: "cdcore@uw.edu", firstName: "Cordero" },
      accessToken: fakeAccessToken(),
    });
    const dbError = new Error("connection refused: ECONNREFUSED");
    dbInsertImpl = () => {
      throw dbError;
    };
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { path, headers } = await loginThenBuildCallbackRequest();
    const res = await auth.request(path, { headers }, TEST_ENV);

    expect(res.status).toBe(503);
    // Oauth state/verifier cookies are still cleared even on this failure
    // path; what matters here is that no session cookie leaks out.
    expect(res.headers.get("set-cookie")).not.toContain(SESSION_COOKIE_NAME);
    const body = await res.text();
    expect(body).toMatch(/try again later/i);
    expect(body).not.toMatch(/ECONNREFUSED/);
    expect(consoleSpy).toHaveBeenCalledWith(expect.anything(), dbError);

    consoleSpy.mockRestore();
    dbInsertImpl = defaultInsertImpl;
  });
});

describe("POST /logout", () => {
  it("clears the session cookie and redirects to / when there is no WorkOS session id", async () => {
    const res = await auth.request("/logout", { method: "POST" }, TEST_ENV);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=;`);
  });

  it("redirects through the WorkOS logout URL when the session has a workosSessionId", async () => {
    authenticateWithCode.mockResolvedValue({
      user: { id: "workos_1", email: "cdcore@uw.edu", firstName: "Cordero" },
      accessToken: fakeAccessToken("session_xyz"),
    });
    const { path, headers } = await loginThenBuildCallbackRequest();
    const callbackRes = await auth.request(path, { headers }, TEST_ENV);
    const sessionCookie = (callbackRes.headers.get("set-cookie") ?? "")
      .split(", ")
      .map((c) => c.split(";")[0])
      .find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));

    const res = await auth.request(
      "/logout",
      { method: "POST", headers: { cookie: sessionCookie ?? "" } },
      TEST_ENV,
    );

    expect(res.status).toBe(302);
    expect(getLogoutUrl).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session_xyz" }),
    );
    expect(res.headers.get("location")).toContain("workos.com");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=;`);
  });
});

/** A JWT with a `sid` claim, unsigned -- callbackHandler only decodes it
 *  (jose.decodeJwt), it never verifies the signature, because the token
 *  just arrived directly from a trusted server-to-server WorkOS API call. */
function fakeAccessToken(sid = "session_fake123"): string {
  const header = base64UrlJson({ alg: "none", typ: "JWT" });
  const payload = base64UrlJson({ sid });
  return `${header}.${payload}.`;
}

function base64UrlJson(obj: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}
