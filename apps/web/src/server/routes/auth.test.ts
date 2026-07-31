import { describe, it, expect, vi, beforeEach } from "vitest";
import { auth } from "./auth";
import { SESSION_COOKIE_NAME } from "../../lib/session";

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

vi.mock("../../lib/workos", () => ({
  getWorkOS: () => ({
    userManagement: { authenticateWithCode, getAuthorizationUrl },
  }),
}));

vi.mock("../../db/client", () => ({
  makeDb: () => ({
    query: { users: { findFirst: async () => undefined } },
    insert: () => ({ values: () => ({ returning: async () => [{ id: "new-user-1" }] }) }),
  }),
}));

beforeEach(() => {
  authenticateWithCode.mockReset();
  getAuthorizationUrl.mockClear();
});

describe("GET /login", () => {
  it("redirects to the WorkOS authorization URL", async () => {
    const res = await auth.request("/login", {}, TEST_ENV);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("workos.com");
  });
});

describe("GET /callback", () => {
  it("returns 400 when the code query param is missing", async () => {
    const res = await auth.request("/callback", {}, TEST_ENV);
    expect(res.status).toBe(400);
  });

  it("returns 401 when WorkOS rejects the code", async () => {
    authenticateWithCode.mockRejectedValue(new Error("invalid_grant"));
    const res = await auth.request("/callback?code=bad", {}, TEST_ENV);
    expect(res.status).toBe(401);
  });

  it("rejects a disallowed email domain with 403 and sets no cookie", async () => {
    authenticateWithCode.mockResolvedValue({
      user: { id: "workos_1", email: "cdcore@gmail.com", firstName: "Cordero" },
    });
    const res = await auth.request("/callback?code=good", {}, TEST_ENV);
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("happy path: sets a session cookie and redirects to /", async () => {
    authenticateWithCode.mockResolvedValue({
      user: { id: "workos_1", email: "cdcore@uw.edu", firstName: "Cordero" },
    });
    const res = await auth.request("/callback?code=good", {}, TEST_ENV);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(SESSION_COOKIE_NAME);
    expect(setCookie).toContain("HttpOnly");
  });
});

describe("POST /logout", () => {
  it("clears the session cookie and redirects to /", async () => {
    const res = await auth.request("/logout", { method: "POST" }, TEST_ENV);
    expect(res.status).toBe(302);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=;`);
  });
});
