import { beforeEach, describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { instructorStudentViewHomeworksHandler, studentHomeworksHandler } from "./studentHomeworks";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import { fakeAuthContext, fakeMembership } from "../testing/authContext";

const TEST_ENV = { DATABASE_URL: "ignored" } as Env;
const getStudentHomeworksForUser = vi.fn();
const getInstructorStudentViewHomeworks = vi.fn();
vi.mock("../repositories/studentHomeworks", () => ({
  getStudentHomeworksForUser: (...args: unknown[]) => getStudentHomeworksForUser(...args),
  getInstructorStudentViewHomeworks: (...args: unknown[]) =>
    getInstructorStudentViewHomeworks(...args),
}));
vi.mock("../../db/client", () => ({ makeDb: () => ({}) }));

function buildApp(authContext: AuthContext | undefined) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { if (authContext) c.set("authContext", authContext); await next(); });
  app.get("/api/student/homeworks", (c) => studentHomeworksHandler(c));
  app.get("/api/courses/:courseId/student-view/homeworks", (c) =>
    instructorStudentViewHomeworksHandler(c),
  );
  return app;
}

beforeEach(() => {
  getStudentHomeworksForUser.mockReset();
  getInstructorStudentViewHomeworks.mockReset();
});


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

describe("GET /api/student/homeworks -- database failure", () => {
  it("answers 503 when getStudentHomeworksForUser fails", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    getStudentHomeworksForUser.mockReset().mockRejectedValue(new Error("Connection terminated unexpectedly"));
    const res = await buildApp(fakeAuthContext({ hasRole: (r) => r === "student" })).request(
      "/api/student/homeworks", {}, TEST_ENV,
    );
    expect(res.status).toBe(503);
    consoleSpy.mockRestore();
  });
});

const COURSE_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_COURSE_ID = "11111111-2222-4333-8444-555555555556";
const instructorPreviewPath = `/api/courses/${COURSE_ID}/student-view/homeworks`;

describe("GET /api/courses/:courseId/student-view/homeworks", () => {
  it("returns student-visible homework for an instructor of the exact course", async () => {
    getInstructorStudentViewHomeworks.mockResolvedValue([
      {
        id: "hw1",
        courseId: COURSE_ID,
        courseName: "STAT 311",
        title: "HW1",
        description: "d",
        dueDate: "2099-01-01T00:00:00.000Z",
        completedPercentage: 0,
        inProgressPercentage: 0,
        sections: [],
        widgets: [],
      },
    ]);
    const authContext = fakeAuthContext({
      memberships: [fakeMembership({ courseId: COURSE_ID, role: "instructor" })],
    });

    const res = await buildApp(authContext).request(instructorPreviewPath, {}, TEST_ENV);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ homeworks: [{ id: "hw1", courseId: COURSE_ID }] });
    expect(getInstructorStudentViewHomeworks).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an instructor of another course", fakeAuthContext({ memberships: [fakeMembership({ courseId: OTHER_COURSE_ID, role: "instructor" })] })],
    ["a TA", fakeAuthContext({ memberships: [fakeMembership({ courseId: COURSE_ID, role: "ta" })] })],
    ["a student", fakeAuthContext({ memberships: [fakeMembership({ courseId: COURSE_ID, role: "student" })] })],
    ["an unauthenticated caller", undefined],
  ])("denies %s without querying preview homework", async (_label, authContext) => {
    const res = await buildApp(authContext).request(instructorPreviewPath, {}, TEST_ENV);

    expect(res.status).toBe(403);
    expect(getInstructorStudentViewHomeworks).not.toHaveBeenCalled();
  });

  it("rejects a malformed course ID before querying the repository", async () => {
    const authContext = fakeAuthContext({
      memberships: [fakeMembership({ courseId: "not-a-uuid", role: "instructor" })],
    });

    const res = await buildApp(authContext).request(
      "/api/courses/not-a-uuid/student-view/homeworks",
      {},
      TEST_ENV,
    );

    expect(res.status).toBe(404);
    expect(getInstructorStudentViewHomeworks).not.toHaveBeenCalled();
  });

  it("answers 503 when the preview repository fails", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    getInstructorStudentViewHomeworks.mockRejectedValue(
      new Error("Connection terminated unexpectedly"),
    );
    const authContext = fakeAuthContext({
      memberships: [fakeMembership({ courseId: COURSE_ID, role: "admin" })],
    });

    const res = await buildApp(authContext).request(instructorPreviewPath, {}, TEST_ENV);

    expect(res.status).toBe(503);
    consoleSpy.mockRestore();
  });
});
