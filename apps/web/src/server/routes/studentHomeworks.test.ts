import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { studentHomeworksHandler } from "./studentHomeworks";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";

const TEST_ENV = { DATABASE_URL: "ignored" } as Env;
const getStudentHomeworksForUser = vi.fn();
vi.mock("../repositories/studentHomeworks", () => ({
  getStudentHomeworksForUser: (...args: unknown[]) => getStudentHomeworksForUser(...args),
}));
vi.mock("../../db/client", () => ({ makeDb: () => ({}) }));

function buildApp(authContext: AuthContext | undefined) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { if (authContext) c.set("authContext", authContext); await next(); });
  app.get("/api/student/homeworks", (c) => studentHomeworksHandler(c));
  return app;
}

function fakeAuthContext(overrides: Partial<AuthContext> = {}): AuthContext {
  const memberships = overrides.memberships ?? [];
  return {
    session: { userId: "u1", workosUserId: "w1", sessionEpoch: 0, issuedAt: 0, expiresAt: 0 },
    memberships,
    hasRole: (role) => memberships.some((m) => m.role === role),
    isMemberOf: (courseId) => memberships.some((m) => m.courseId === courseId),
    isInstructorOf: () => false,
    ...overrides,
  };
}

describe("GET /api/student/homeworks", () => {
  it("returns 401-shaped 403 when unauthenticated", async () => {
    const res = await buildApp(undefined).request("/api/student/homeworks", {}, TEST_ENV);
    expect(res.status).toBe(403);
  });

  it("denies a non-student (teacher-only membership) with 403", async () => {
    const res = await buildApp(fakeAuthContext({ hasRole: (r) => r === "instructor" })).request(
      "/api/student/homeworks", {}, TEST_ENV,
    );
    expect(res.status).toBe(403);
  });

  it("returns the student's homeworks", async () => {
    getStudentHomeworksForUser.mockReset().mockResolvedValue([
      { id: "hw1", title: "HW1", description: "d", dueDate: "2099-01-01T00:00:00.000Z", completedPercentage: 50, inProgressPercentage: 50, sections: [] },
    ]);
    const res = await buildApp(fakeAuthContext({ hasRole: (r) => r === "student" })).request(
      "/api/student/homeworks", {}, TEST_ENV,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { homeworks: unknown[] };
    expect(body.homeworks).toHaveLength(1);
  });
});
