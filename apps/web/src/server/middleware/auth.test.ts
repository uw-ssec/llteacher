import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { authMiddleware } from "./auth";
import {
  createSessionPayload,
  loadSessionKey,
  sealSession,
  SESSION_COOKIE_NAME,
} from "../../lib/session";
import type { AppEnv } from "../context";

const TEST_ENV = {
  SESSION_SECRET: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
} as Env;

function buildApp() {
  const app = new Hono<AppEnv>();
  app.use("*", authMiddleware);
  app.get("/api/protected", (c) => {
    const session = c.get("session");
    return c.json({ session });
  });
  app.get("/api/auth/login", (c) => c.text("login stub"));
  return app;
}

describe("authMiddleware", () => {
  it("returns 401 for /api/* with no cookie", async () => {
    const res = await buildApp().request("/api/protected", {}, TEST_ENV);
    expect(res.status).toBe(401);
  });

  it("returns 401 for an expired session", async () => {
    const key = await loadSessionKey(TEST_ENV);
    const expired = createSessionPayload(
      "user-1",
      "workos-1",
      Date.now() - 1000 * 60 * 60 * 24 * 30,
    );
    const sealed = await sealSession(expired, key);
    const res = await buildApp().request(
      "/api/protected",
      { headers: { cookie: `${SESSION_COOKIE_NAME}=${sealed}` } },
      TEST_ENV,
    );
    expect(res.status).toBe(401);
  });

  it("attaches the session and allows the request through when valid", async () => {
    const key = await loadSessionKey(TEST_ENV);
    const payload = createSessionPayload("user-1", "workos-1");
    const sealed = await sealSession(payload, key);
    const res = await buildApp().request(
      "/api/protected",
      { headers: { cookie: `${SESSION_COOKIE_NAME}=${sealed}` } },
      TEST_ENV,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: { userId: string } };
    expect(body.session.userId).toBe("user-1");
  });

  it("does not require a session for /api/auth/* routes", async () => {
    const res = await buildApp().request("/api/auth/login", {}, TEST_ENV);
    expect(res.status).toBe(200);
  });

  it("requires a session for an /api/auth/* path that is not login, callback, or logout", async () => {
    const res = await buildApp().request("/api/auth/some-future-endpoint", {}, TEST_ENV);
    expect(res.status).toBe(401);
  });
});
