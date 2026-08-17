import { describe, it, expect, vi, beforeEach } from "vitest";
import app from "./index";
import {
  SESSION_COOKIE_NAME,
  createSessionPayload,
  loadSessionKey,
  sealSession,
} from "../lib/session";
import { TenancyMismatchError, PromptTemplateConflictError } from "./repositories/errors";

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
  // #308: createConversationHandler's per-user conversation cap -- stubbed
  // to "no active conversations" so the #141 test below (the only test in
  // this file that reaches POST /api/conversations) doesn't need to know
  // about the cap to exercise the TenancyMismatchError mapping it's after.
  countActiveConversationsForOwner: vi.fn().mockResolvedValue(0),
  updateConversationTitle: vi.fn(),
  softDeleteConversation: vi.fn(),
  getConversationById: vi.fn(),
  getMessagesForConversation: vi.fn(),
}));

// #308: createConversationHandler also rate-limits now (shares chat.ts's
// #219/#265 counter) -- stubbed the same way chat.test.ts stubs it, real db
// calls would throw against this file's fake `db` (no `.insert`/`.batch`).
vi.mock("./repositories/rateLimits", () => ({
  reserveRateLimitSlot: vi.fn().mockResolvedValue(1),
  RATE_LIMIT_MAX_PER_MINUTE: 20,
  RATE_LIMIT_WINDOW_MS: 60_000,
}));

// #317 review, code-review follow-up: only upsertCourseScopedPromptTemplate
// is exercised below (the PromptTemplateConflictError-mapping test) -- the
// other two exports are no-op stubs so importing the real
// routes/promptTemplates.ts module doesn't throw for tests that never hit
// this route.
const upsertCourseScopedPromptTemplateMock = vi.fn();
vi.mock("./repositories/promptTemplates", () => ({
  getCourseScopedPromptTemplate: vi.fn(),
  upsertCourseScopedPromptTemplate: (...args: unknown[]) => upsertCourseScopedPromptTemplateMock(...args),
  deactivateCourseScopedPromptTemplate: vi.fn(),
}));

beforeEach(() => {
  findMany.mockReset();
  findFirst.mockReset();
  findFirst.mockResolvedValue({ isActive: true, sessionEpoch: 0 });
  createConversationMock.mockReset();
  upsertCourseScopedPromptTemplateMock.mockReset();
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

  // #317 review, code-review follow-up: upsertCourseScopedPromptTemplate
  // (repositories/promptTemplates.ts) throws this when two concurrent
  // writers race the same course's scoped template -- same single-
  // chokepoint mapping as TenancyMismatchError/IdempotencyKeyConflictError
  // above, proven the same way.
  it("maps a PromptTemplateConflictError to 409 (not the generic 503) and does not log it as a server error", async () => {
    const courseId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    findMany.mockResolvedValue([
      { id: "m1", userId: "u1", courseId, role: "instructor", droppedAt: null },
    ]);
    upsertCourseScopedPromptTemplateMock.mockRejectedValue(
      new PromptTemplateConflictError("This course's tutor prompt was just changed by someone else. Reload and try again."),
    );
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const key = await loadSessionKey(ENV);
    const sealed = await sealSession(createSessionPayload("u1", "w1", 0), key);

    const res = await app.request(
      `/api/courses/${courseId}/prompt-template`,
      {
        method: "PUT",
        headers: { cookie: `${SESSION_COOKIE_NAME}=${sealed}`, "content-type": "application/json" },
        body: JSON.stringify({ content: "new content" }),
      },
      ENV,
    );

    expect(res.status).toBe(409);
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

/** #172 audit (CMP-005): a missing API route must be an unambiguous JSON
 *  404, not the SPA shell with a 200. During a rolling deploy where the
 *  admin bundle leads the Worker, the 200 made `r.ok` true and left the
 *  client failing only because JSON.parse choked on HTML. */
describe("unmatched /api/* routes (#172 audit)", () => {
  it("404s with JSON rather than serving the SPA shell", async () => {
    // Authenticated: authMiddleware gates /api/* ahead of this catch-all, so
    // an anonymous caller gets 401 and cannot probe which routes exist --
    // which is the behaviour we want, and why this test needs a session.
    findMany.mockResolvedValue([]);
    const key = await loadSessionKey(ENV);
    const sealed = await sealSession(createSessionPayload("u1", "w1", 0), key);
    const res = await app.request(
      "/api/does-not-exist",
      { headers: { cookie: `${SESSION_COOKIE_NAME}=${sealed}` } },
      ENV,
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("leaves non-API paths to the asset binding", async () => {
    // ENV's ASSETS stub answers every request with "not found"/404, so the
    // meaningful assertion is that the SPA path reached it rather than being
    // answered by the JSON catch-all above.
    const res = await app.request("/some/spa/route", {}, ENV);
    expect(res.headers.get("content-type")).not.toContain("application/json");
    expect(await res.text()).toBe("not found");
  });
});
