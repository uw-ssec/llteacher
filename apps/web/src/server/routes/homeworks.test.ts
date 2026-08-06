import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import {
  listHomeworksHandler,
  createHomeworkHandler,
  getHomeworkDetailHandler,
  updateHomeworkHandler,
  deleteHomeworkHandler,
  publishHomeworkHandler,
} from "./homeworks";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";

const TEST_ENV = { DATABASE_URL: "ignored" } as Env;

const findManyHomeworks = vi.fn();
const insertHomework = vi.fn();
const findFirstHomework = vi.fn();
const findManySections = vi.fn();
vi.mock("../../db/client", () => ({
  makeDb: () => ({
    query: {
      homeworks: {
        findMany: (...args: unknown[]) => findManyHomeworks(...args),
        findFirst: (...args: unknown[]) => findFirstHomework(...args),
      },
      sections: { findMany: (...args: unknown[]) => findManySections(...args) },
    },
    insert: (...args: unknown[]) => insertHomework(...args),
  }),
}));

// updateHomeworkHandler's constraint-violation (422) and unresolvable-cycle
// paths originate deep inside updateHomework's transaction/batch logic
// (planSectionDiff + resolveSectionWrites) -- reaching them through the
// db-client mock above would mean simulating that whole internal call
// graph. Mocking the repository function directly instead lets each test
// drive updateHomework's return/throw contract in one line, while
// `importOriginal` keeps every other exported repository function (used by
// the handlers above) running against their real implementation over the
// already-mocked db client.
const updateHomeworkMock = vi.fn();
const deleteHomeworkMock = vi.fn();
const publishHomeworkMock = vi.fn();
vi.mock("../repositories/homeworks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repositories/homeworks")>();
  return {
    ...actual,
    updateHomework: (...args: unknown[]) => updateHomeworkMock(...args),
    deleteHomework: (...args: unknown[]) => deleteHomeworkMock(...args),
    updateHomeworkPublishState: (...args: unknown[]) => publishHomeworkMock(...args),
  };
});

// Derives hasRole/isMemberOf/isInstructorOf from `memberships` the same way
// rolesMiddleware does in production, so a test that sets `memberships` gets
// consistent predicates for free -- callers can still override any
// individual predicate to test a mismatch (e.g. isInstructorOf true but no
// matching membership row).
function fakeAuthContext(overrides: Partial<AuthContext> = {}): AuthContext {
  const memberships = overrides.memberships ?? [];
  return {
    session: { userId: "u1", workosUserId: "w1", sessionEpoch: 0, issuedAt: 0, expiresAt: 0 },
    memberships,
    hasRole: (role) => memberships.some((m) => m.role === role),
    isMemberOf: (courseId) => memberships.some((m) => m.courseId === courseId),
    isInstructorOf: (courseId) =>
      memberships.some((m) => m.courseId === courseId && (m.role === "instructor" || m.role === "admin")),
    ...overrides,
  };
}

function buildApp(authContext: AuthContext | undefined) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    if (authContext) c.set("authContext", authContext);
    await next();
  });
  app.get("/api/courses/:courseId/homeworks", (c) => listHomeworksHandler(c));
  app.post("/api/courses/:courseId/homeworks", (c) => createHomeworkHandler(c));
  app.get("/api/courses/:courseId/homeworks/:homeworkId", (c) => getHomeworkDetailHandler(c));
  app.patch("/api/courses/:courseId/homeworks/:homeworkId", (c) => updateHomeworkHandler(c));
  app.delete("/api/courses/:courseId/homeworks/:homeworkId", (c) => deleteHomeworkHandler(c));
  app.patch("/api/courses/:courseId/homeworks/:homeworkId/publish", (c) => publishHomeworkHandler(c));
  return app;
}

describe("GET /api/courses/:courseId/homeworks", () => {
  it("denies a non-member with 403", async () => {
    findManyHomeworks.mockReset();
    const res = await buildApp(fakeAuthContext()).request(
      "/api/courses/course-a/homeworks",
      {},
      TEST_ENV,
    );
    expect(res.status).toBe(403);
    expect(findManyHomeworks).not.toHaveBeenCalled();
  });

  it("allows a course member and lists that course's homeworks", async () => {
    findManyHomeworks.mockReset().mockResolvedValue([{ id: "hw1", title: "HW 1" }]);
    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a" }),
    ).request("/api/courses/course-a/homeworks", {}, TEST_ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { homeworks: unknown[] };
    expect(body.homeworks).toHaveLength(1);
  });

  it("denies access to a different course than the one the user is a member of (cross-course)", async () => {
    findManyHomeworks.mockReset();
    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-b" }),
    ).request("/api/courses/course-a/homeworks", {}, TEST_ENV);
    expect(res.status).toBe(403);
  });
});

describe("POST /api/courses/:courseId/homeworks", () => {
  it("denies a student with 403", async () => {
    insertHomework.mockReset();
    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: () => false }),
    ).request(
      "/api/courses/course-a/homeworks",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "New HW", description: "desc", dueDate: "2026-12-01" }),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(403);
    expect(insertHomework).not.toHaveBeenCalled();
  });

  it("denies an instructor of a different course (cross-course) with 403", async () => {
    insertHomework.mockReset();
    const res = await buildApp(
      fakeAuthContext({ isInstructorOf: (id) => id === "course-b" }),
    ).request(
      "/api/courses/course-a/homeworks",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "New HW", description: "desc", dueDate: "2026-12-01" }),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(403);
  });

  it("allows the instructor of the course to create a homework", async () => {
    insertHomework.mockReset().mockReturnValue({
      values: () => ({ returning: async () => [{ id: "hw-new" }] }),
    });
    const membership = { id: "membership-1", userId: "u1", courseId: "course-a", role: "instructor" } as unknown as AuthContext["memberships"][number];
    const res = await buildApp(
      fakeAuthContext({
        isInstructorOf: (id) => id === "course-a",
        memberships: [membership],
      }),
    ).request(
      "/api/courses/course-a/homeworks",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "New HW", description: "desc", dueDate: "2026-12-01" }),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe("hw-new");
  });

  it("returns 400 when required fields are missing", async () => {
    const membership = { id: "membership-1", userId: "u1", courseId: "course-a", role: "instructor" } as unknown as AuthContext["memberships"][number];
    const res = await buildApp(
      fakeAuthContext({ isInstructorOf: (id) => id === "course-a", memberships: [membership] }),
    ).request(
      "/api/courses/course-a/homeworks",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "" }),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 (not 503) for an unparseable dueDate", async () => {
    insertHomework.mockReset();
    const membership = { id: "membership-1", userId: "u1", courseId: "course-a", role: "instructor" } as unknown as AuthContext["memberships"][number];
    const res = await buildApp(
      fakeAuthContext({ isInstructorOf: (id) => id === "course-a", memberships: [membership] }),
    ).request(
      "/api/courses/course-a/homeworks",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "New HW", description: "desc", dueDate: "banana" }),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect(insertHomework).not.toHaveBeenCalled();
  });

  it("returns 400 (not 503) for a malformed JSON body", async () => {
    insertHomework.mockReset();
    const membership = { id: "membership-1", userId: "u1", courseId: "course-a", role: "instructor" } as unknown as AuthContext["memberships"][number];
    const res = await buildApp(
      fakeAuthContext({ isInstructorOf: (id) => id === "course-a", memberships: [membership] }),
    ).request(
      "/api/courses/course-a/homeworks",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect(insertHomework).not.toHaveBeenCalled();
  });

  it("returns 403 (not an unguarded throw) when authContext is missing -- guard-composition regression coverage", async () => {
    insertHomework.mockReset();
    const res = await buildApp(undefined).request(
      "/api/courses/course-a/homeworks",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "New HW", description: "desc", dueDate: "2026-12-01" }),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(403);
    expect(insertHomework).not.toHaveBeenCalled();
  });
});

describe("GET /api/courses/:courseId/homeworks/:homeworkId", () => {
  it("denies a non-member with 403", async () => {
    const res = await buildApp(fakeAuthContext()).request(
      "/api/courses/course-a/homeworks/hw-1", {}, TEST_ENV,
    );
    expect(res.status).toBe(403);
  });

  it("returns 404 when the homework isn't found in this course scope", async () => {
    findFirstHomework.mockReset().mockResolvedValue(undefined);
    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a" }),
    ).request("/api/courses/course-a/homeworks/hw-1", {}, TEST_ENV);
    expect(res.status).toBe(404);
  });

  it("returns sections + status for a course member (student payload has no editableBy)", async () => {
    findFirstHomework.mockReset().mockResolvedValue({
      // dueDate is deliberately in the past (not 2099) -- deriveHomeworkStatus
      // (Task 3) returns "past_due" only when dueDate has already passed;
      // publishedAt/releasedAt in the past alone would otherwise yield "active".
      id: "hw-1", courseId: "course-a", title: "HW1", description: "d",
      dueDate: new Date("2020-01-02"), llmConfigId: null, publishedAt: new Date("2020-01-01"), releasedAt: new Date("2020-01-01"),
    });
    findManySections.mockReset().mockResolvedValue([
      { id: "s1", title: "Sec 1", content: "c1", order: 1, solution: null, createdAt: new Date(), updatedAt: new Date() },
    ]);
    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: () => false }),
    ).request("/api/courses/course-a/homeworks/hw-1", {}, TEST_ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { editableBy?: boolean; status: string; sections: unknown[] };
    expect(body.editableBy).toBeUndefined();
    expect(body.status).toBe("past_due");
    expect(body.sections).toHaveLength(1);
  });

  it("sets editableBy=true for an instructor of the course", async () => {
    findFirstHomework.mockReset().mockResolvedValue({
      id: "hw-1", courseId: "course-a", title: "HW1", description: "d",
      dueDate: new Date("2099-01-01"), llmConfigId: null, publishedAt: null, releasedAt: null,
    });
    findManySections.mockReset().mockResolvedValue([]);
    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" }),
    ).request("/api/courses/course-a/homeworks/hw-1", {}, TEST_ENV);
    const body = (await res.json()) as { editableBy?: boolean };
    expect(body.editableBy).toBe(true);
  });
});

describe("PATCH /api/courses/:courseId/homeworks/:homeworkId", () => {
  it("denies a non-instructor with 403", async () => {
    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: () => false }),
    ).request("/api/courses/course-a/homeworks/hw-1", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sections: [] }),
    }, TEST_ENV);
    expect(res.status).toBe(403);
  });

  it("returns 404 when updateHomework resolves null (not found in scope)", async () => {
    updateHomeworkMock.mockReset().mockResolvedValue(null);
    const res = await buildApp(
      // isMemberOf must also hold, matching createHomeworkHandler's tests
      // above -- courseScopeFromAuthContext (used by both handlers) mints a
      // scope from isMemberOf, not isInstructorOf; in production a course
      // membership row is what backs both predicates, but the fakeAuthContext
      // test double lets them diverge, so each override must be set explicitly.
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" }),
    ).request("/api/courses/course-a/homeworks/hw-1", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "New title" }),
    }, TEST_ENV);
    expect(res.status).toBe(404);
  });

  it("returns 422 with a friendly message when the diff violates the order constraint", async () => {
    updateHomeworkMock.mockReset().mockRejectedValue(new Error("duplicate order 1 in incoming sections"));
    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" }),
    ).request("/api/courses/course-a/homeworks/hw-1", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sections: [{ title: "A", content: "a", order: 1 }, { title: "B", content: "b", order: 1 }] }),
    }, TEST_ENV);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/order/i);
  });

  it("applies a valid update and returns 200", async () => {
    updateHomeworkMock.mockReset().mockResolvedValue({ id: "hw-1" });
    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" }),
    ).request("/api/courses/course-a/homeworks/hw-1", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Updated" }),
    }, TEST_ENV);
    expect(res.status).toBe(200);
  });

  // C1: an uncontrolled <select> (apps/admin's HomeworkForm) always sends a
  // string, never `undefined`, for its "(course/org default)" option -- that
  // arrives here as `""`. Without normalization this reaches updateHomework's
  // `!== undefined` guard and Postgres throws on `UPDATE ... SET
  // llm_config_id = ''` against a uuid column, which becomes a generic 503.
  it("normalizes llmConfigId: '' to null and returns 200 (not 503)", async () => {
    updateHomeworkMock.mockReset().mockResolvedValue({ id: "hw-1", llmConfigId: null });
    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" }),
    ).request("/api/courses/course-a/homeworks/hw-1", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ llmConfigId: "" }),
    }, TEST_ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { llmConfigId: string | null };
    expect(body.llmConfigId).toBeNull();
    expect(updateHomeworkMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "hw-1",
      expect.objectContaining({ llmConfigId: null }),
    );
  });

  it("rejects a non-UUID llmConfigId with 400", async () => {
    updateHomeworkMock.mockReset();
    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" }),
    ).request("/api/courses/course-a/homeworks/hw-1", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ llmConfigId: "not-a-uuid" }),
    }, TEST_ENV);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/uuid/i);
    expect(updateHomeworkMock).not.toHaveBeenCalled();
  });

  it("still applies a valid UUID llmConfigId (regression check)", async () => {
    const validUuid = "123e4567-e89b-12d3-a456-426614174000";
    updateHomeworkMock.mockReset().mockResolvedValue({ id: "hw-1", llmConfigId: validUuid });
    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" }),
    ).request("/api/courses/course-a/homeworks/hw-1", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ llmConfigId: validUuid }),
    }, TEST_ENV);
    expect(res.status).toBe(200);
    expect(updateHomeworkMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "hw-1",
      expect.objectContaining({ llmConfigId: validUuid }),
    );
  });
});

describe("DELETE /api/courses/:courseId/homeworks/:homeworkId", () => {
  it("denies a non-instructor with 403", async () => {
    const res = await buildApp(
      fakeAuthContext({ isInstructorOf: () => false }),
    ).request("/api/courses/course-a/homeworks/hw-1", { method: "DELETE" }, TEST_ENV);
    expect(res.status).toBe(403);
  });

  it("returns 404 when not found in scope", async () => {
    deleteHomeworkMock.mockReset().mockResolvedValue(null);
    const res = await buildApp(
      // isMemberOf must also be true -- courseScopeFromAuthContext requires
      // it independent of isInstructorOf (same gap found and fixed in Tasks
      // 5/6's test fixtures; fixed proactively here before dispatch).
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" }),
    ).request("/api/courses/course-a/homeworks/hw-1", { method: "DELETE" }, TEST_ENV);
    expect(res.status).toBe(404);
  });

  it("deletes and returns 204", async () => {
    deleteHomeworkMock.mockReset().mockResolvedValue({ id: "hw-1" });
    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" }),
    ).request("/api/courses/course-a/homeworks/hw-1", { method: "DELETE" }, TEST_ENV);
    expect(res.status).toBe(204);
  });
});

describe("PATCH /api/courses/:courseId/homeworks/:homeworkId/publish", () => {
  it("denies a non-instructor with 403", async () => {
    const res = await buildApp(fakeAuthContext({ isInstructorOf: () => false })).request(
      "/api/courses/course-a/homeworks/hw-1/publish",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ publish: true }) },
      TEST_ENV,
    );
    expect(res.status).toBe(403);
  });

  it("rejects a past releasedAt with 400", async () => {
    const res = await buildApp(fakeAuthContext({ isInstructorOf: (id) => id === "course-a" })).request(
      "/api/courses/course-a/homeworks/hw-1/publish",
      {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ publish: true, releasedAt: "2020-01-01T00:00:00Z" }),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
  });

  it("publishes immediately when releasedAt is omitted", async () => {
    publishHomeworkMock.mockReset().mockResolvedValue({ id: "hw-1", publishedAt: new Date(), releasedAt: new Date() });
    // isMemberOf required alongside isInstructorOf -- this test reaches
    // courseScopeFromAuthContext (the 400/past-releasedAt test above does
    // not, since that check runs before scope minting). Same gap found in
    // Tasks 5/6/7; fixed proactively here before dispatch.
    const res = await buildApp(fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" })).request(
      "/api/courses/course-a/homeworks/hw-1/publish",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ publish: true }) },
      TEST_ENV,
    );
    expect(res.status).toBe(200);
  });

  it("un-publishes (draft) when publish=false", async () => {
    publishHomeworkMock.mockReset().mockResolvedValue({ id: "hw-1", publishedAt: null, releasedAt: null });
    const res = await buildApp(fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" })).request(
      "/api/courses/course-a/homeworks/hw-1/publish",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ publish: false }) },
      TEST_ENV,
    );
    expect(res.status).toBe(200);
  });
});
