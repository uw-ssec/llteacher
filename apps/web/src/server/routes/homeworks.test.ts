import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { listHomeworksHandler, createHomeworkHandler } from "./homeworks";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";

const TEST_ENV = { DATABASE_URL: "ignored" } as Env;

const findManyHomeworks = vi.fn();
const insertHomework = vi.fn();
vi.mock("../../db/client", () => ({
  makeDb: () => ({
    query: { homeworks: { findMany: (...args: unknown[]) => findManyHomeworks(...args) } },
    insert: (...args: unknown[]) => insertHomework(...args),
  }),
}));

function fakeAuthContext(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    session: { userId: "u1", workosUserId: "w1", issuedAt: 0, expiresAt: 0 },
    memberships: [],
    hasRole: () => false,
    isMemberOf: () => false,
    isInstructorOf: () => false,
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
});
