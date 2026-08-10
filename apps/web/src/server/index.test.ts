import { describe, it, expect, vi, beforeEach } from "vitest";
import app from "./index";
import {
  SESSION_COOKIE_NAME,
  createSessionPayload,
  loadSessionKey,
  sealSession,
} from "../lib/session";
import { TenancyMismatchError } from "./repositories/errors";

const SESSION_SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");

const ENV = {
  ASSETS: { fetch: async () => new Response("not found", { status: 404 }) },
  WORKOS_API_KEY: "sk_test_x",
  WORKOS_CLIENT_ID: "client_x",
  SESSION_SECRET,
  DATABASE_URL: "ignored",
} as unknown as Env;

const findMany = vi.fn();
const findFirst = vi.fn();
vi.mock("../db/client", () => ({
  makeDb: () => ({
    query: {
      courseMemberships: { findMany: (...args: unknown[]) => findMany(...args) },
      users: { findFirst: (...args: unknown[]) => findFirst(...args) },
    },
  }),
}));

// Only createConversation is exercised below (the #141 onError-mapping
// test) -- every other export is a no-op stub so importing the real
// routes/conversations.ts module (which imports all of these) doesn't
// throw for the tests in this file that never hit /api/conversations.
const createConversationMock = vi.fn();
vi.mock("./repositories/conversations", () => ({
  listConversationsForOwner: vi.fn(),
  createConversation: (...args: unknown[]) => createConversationMock(...args),
  updateConversationTitle: vi.fn(),
  softDeleteConversation: vi.fn(),
  getConversationById: vi.fn(),
  getMessagesForConversation: vi.fn(),
}));

beforeEach(() => {
  findMany.mockReset();
  findFirst.mockReset();
  findFirst.mockResolvedValue({ isActive: true, sessionEpoch: 0 });
  createConversationMock.mockReset();
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
    const sealed = await sealSession(createSessionPayload("u1", "w1", 0), key);

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

  it("maps a TenancyMismatchError to 404 (not the generic 503) and does not log it as a server error (#141)", async () => {
    const courseId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    findMany.mockResolvedValue([
      { id: "m1", userId: "u1", courseId, role: "student", droppedAt: null },
    ]);
    createConversationMock.mockRejectedValue(new TenancyMismatchError("Owner is not a member of this course scope"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const key = await loadSessionKey(ENV);
    const sealed = await sealSession(createSessionPayload("u1", "w1", 0), key);

    const res = await app.request(
      "/api/conversations",
      {
        method: "POST",
        headers: { cookie: `${SESSION_COOKIE_NAME}=${sealed}`, "content-type": "application/json" },
        body: JSON.stringify({ courseId }),
      },
      ENV,
    );

    expect(res.status).toBe(404);
    expect(consoleSpy).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it("denies an unauthenticated request to the mounted homeworks route with 401 (before the guard even runs)", async () => {
    const res = await app.request("/api/courses/course-a/homeworks", {}, ENV);
    expect(res.status).toBe(401);
  });

  it("logout succeeds even when the membership query would reject (skips rolesMiddleware entirely)", async () => {
    findMany.mockRejectedValue(new Error("connection refused: ECONNREFUSED"));

    const key = await loadSessionKey(ENV);
    const sealed = await sealSession(createSessionPayload("u1", "w1", 0), key);

    const res = await app.request(
      "/api/auth/logout",
      { method: "POST", headers: { cookie: `${SESSION_COOKIE_NAME}=${sealed}` } },
      ENV,
    );

    expect(res.status).not.toBe(503);
    expect(findMany).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
    expect(res.headers.get("set-cookie")).toMatch(new RegExp(`${SESSION_COOKIE_NAME}=;`));
  });

  it("a route that genuinely needs roles still 503s under the same DB outage", async () => {
    const dbError = new Error("connection refused: ECONNREFUSED");
    findMany.mockRejectedValue(dbError);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const key = await loadSessionKey(ENV);
    const sealed = await sealSession(createSessionPayload("u1", "w1", 0), key);

    const res = await app.request(
      "/api/courses/course-a/homeworks",
      { headers: { cookie: `${SESSION_COOKIE_NAME}=${sealed}` } },
      ENV,
    );

    expect(res.status).toBe(503);
    consoleSpy.mockRestore();
  });
});
