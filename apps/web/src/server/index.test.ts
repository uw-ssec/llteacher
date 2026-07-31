import { describe, it, expect, vi, beforeEach } from "vitest";
import app from "./index";
import {
  SESSION_COOKIE_NAME,
  createSessionPayload,
  loadSessionKey,
  sealSession,
} from "../lib/session";

const SESSION_SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");

const ENV = {
  ASSETS: { fetch: async () => new Response("not found", { status: 404 }) },
  WORKOS_API_KEY: "sk_test_x",
  WORKOS_CLIENT_ID: "client_x",
  SESSION_SECRET,
  DATABASE_URL: "ignored",
} as unknown as Env;

const findMany = vi.fn();
vi.mock("../db/client", () => ({
  makeDb: () => ({ query: { courseMemberships: { findMany: (...args: unknown[]) => findMany(...args) } } }),
}));

beforeEach(() => {
  findMany.mockReset();
});

describe("app composition", () => {
  it("does not require a session for /api/auth/login", async () => {
    const res = await app.request("/api/auth/login", {}, ENV);
    expect(res.status).not.toBe(401);
  });

  it("gates every other /api/* route behind a session, including pre-existing ones", async () => {
    // This is the intended M1 behavior (issue #8 + epic #13 acceptance
    // criteria): the whole point of this epic is that fixture-identity
    // routes like /api/hello and /api/chat stop being anonymous.
    const helloRes = await app.request("/api/hello", {}, ENV);
    expect(helloRes.status).toBe(401);

    const chatRes = await app.request("/api/chat", { method: "POST" }, ENV);
    expect(chatRes.status).toBe(401);
  });

  it("returns a generic 503 (and logs the real error) when a DB call throws mid-request", async () => {
    const dbError = new Error("connection refused: ECONNREFUSED");
    findMany.mockRejectedValue(dbError);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const key = await loadSessionKey(ENV);
    const sealed = await sealSession(createSessionPayload("u1", "w1"), key);

    const res = await app.request(
      "/api/hello",
      { headers: { cookie: `${SESSION_COOKIE_NAME}=${sealed}` } },
      ENV,
    );

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toMatch(/ECONNREFUSED/);
    expect(consoleSpy).toHaveBeenCalledWith(expect.anything(), dbError);

    consoleSpy.mockRestore();
  });

  it("denies an unauthenticated request to the mounted homeworks route with 401 (before the guard even runs)", async () => {
    const res = await app.request("/api/courses/course-a/homeworks", {}, ENV);
    expect(res.status).toBe(401);
  });
});
