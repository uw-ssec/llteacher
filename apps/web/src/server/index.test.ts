import { describe, it, expect, vi, beforeEach } from "vitest";
import { app } from "./index";
import {
  SESSION_COOKIE_NAME,
  createSessionPayload,
  loadSessionKey,
  sealSession,
} from "../lib/session";
import { TenancyMismatchError, PromptTemplateConflictError } from "./repositories/errors";

const SESSION_SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");

const ENV = {
  APP_URL: "https://llteacher.test",
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
  it("reports the release build SHA from the public health endpoint", async () => {
    const previous = process.env.BUILD_SHA;
    process.env.BUILD_SHA = "abc123";
    const res = await app.request("/api/health", {}, ENV);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "ok", version: "abc123" });
    if (previous === undefined) delete process.env.BUILD_SHA;
    else process.env.BUILD_SHA = previous;
  });

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
    // #275: logServerError now emits one JSON line (via console.error)
    // instead of two separate args -- assert on the parsed payload's
    // `message` field rather than a literal Error object.
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(consoleSpy.mock.calls[0]![0] as string) as Record<string, unknown>;
    expect(logged.message).toBe(dbError.message);

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

/** Task 17 (#42): every knowledge-management route must be registered
 *  through requireInstructorOf(), not just guarded from inside the handler.
 *
 *  Each handler also calls instructorScope() (utils/guards.ts) itself, so a
 *  student is refused either way -- but the two layers answer with
 *  different bodies. The handler's own check (see e.g.
 *  routes/materials.ts's `if (!scope) return c.json({ error: "Not
 *  permitted." }, 403)`) never runs when the wrapper is in place, because
 *  requireInstructorOf() short-circuits first with `{ error: "Instructor
 *  access denied" }` (utils/guards.ts). Asserting on that exact message,
 *  through the real exported `app` rather than a per-route test file's own
 *  minimal Hono mount, is what would actually fail if a future edit
 *  registered one of these routes bare: the response would still be a 403,
 *  just the handler's "Not permitted." instead of the wrapper's "Instructor
 *  access denied." */
describe("knowledge management routes are wrapped in requireInstructorOf (#42, Task 17)", () => {
  const COURSE_ID = "course-km";
  const OTHER_ID = "11111111-2222-4333-8444-555555555555";

  const ROUTES: Array<{ method: string; path: string }> = [
    { method: "GET", path: `/api/courses/${COURSE_ID}/materials` },
    { method: "POST", path: `/api/courses/${COURSE_ID}/materials` },
    { method: "DELETE", path: `/api/courses/${COURSE_ID}/materials/${OTHER_ID}` },
    { method: "POST", path: `/api/courses/${COURSE_ID}/materials/${OTHER_ID}/reingest` },
    { method: "GET", path: `/api/courses/${COURSE_ID}/knowledge/documents` },
    { method: "POST", path: `/api/courses/${COURSE_ID}/knowledge/documents` },
    { method: "GET", path: `/api/courses/${COURSE_ID}/knowledge/documents/${OTHER_ID}` },
    { method: "PUT", path: `/api/courses/${COURSE_ID}/knowledge/documents/${OTHER_ID}` },
    { method: "DELETE", path: `/api/courses/${COURSE_ID}/knowledge/documents/${OTHER_ID}` },
    { method: "GET", path: `/api/courses/${COURSE_ID}/knowledge/documents/${OTHER_ID}/links` },
    { method: "GET", path: `/api/courses/${COURSE_ID}/knowledge/search?q=x` },
  ];

  it("registers exactly 11 knowledge-management routes -- this list must grow with the route table", () => {
    expect(ROUTES).toHaveLength(11);
  });

  it.each(ROUTES)(
    "refuses a course member who is not an instructor via the wrapper, not the handler ($method $path)",
    async ({ method, path }) => {
      findMany.mockResolvedValue([
        { id: "m1", userId: "u1", courseId: COURSE_ID, role: "student", droppedAt: null },
      ]);

      const key = await loadSessionKey(ENV);
      const sealed = await sealSession(createSessionPayload("u1", "w1", 0), key);

      const res = await app.request(
        path,
        { method, headers: { cookie: `${SESSION_COOKIE_NAME}=${sealed}` } },
        ENV,
      );

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Instructor access denied" });
    },
  );
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

  it("leaves non-API paths for the Node static server", async () => {
    const res = await app.request("/some/spa/route", {}, ENV);
    expect(res.status).toBe(404);
  });
});
