import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../context";
import { fakeAuthContext } from "../testing/authContext";
import { addCourseInstructorHandler, listPlatformCoursesHandler, provisionCourseHandler } from "./courseProvisioning";

const provisionMock = vi.fn();
const addInstructorMock = vi.fn();
const auditBestEffortMock = vi.fn();
const listPlatformCoursesMock = vi.fn();
vi.mock("../repositories/courseProvisioning", async (importOriginal) => ({
  isValidInstructorEmail: (await importOriginal<typeof import("../repositories/courseProvisioning")>()).isValidInstructorEmail,
  addInstructorToCourse: (...a: unknown[]) => addInstructorMock(...a),
  provisionInstructorCourse: (...a: unknown[]) => provisionMock(...a),
}));
vi.mock("../repositories/platformListings", () => ({ listPlatformCourses: (...a: unknown[]) => listPlatformCoursesMock(...a) }));
vi.mock("../utils/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/audit")>();
  return { ...actual, auditBestEffort: (...a: unknown[]) => auditBestEffortMock(...a) };
});
vi.mock("../../db/client", () => ({ makeDb: () => ({}) }));
vi.mock("../../lib/secrets-loader", () => ({ loadIdentityCipherKeys: async () => ({}) }));
vi.mock("../../lib/crypto/identity-cipher", () => ({ IdentityCipher: class {} }));

function post(superAdmin: boolean, body: unknown) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("authContext", fakeAuthContext({ isSuperAdmin: superAdmin })); await next(); });
  app.post("/api/platform/courses", provisionCourseHandler);
  return app.request("/api/platform/courses", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }, { DATABASE_URL: "ignored" } as Env);
}

function get(superAdmin: boolean) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("authContext", fakeAuthContext({ isSuperAdmin: superAdmin })); await next(); });
  app.get("/api/platform/courses", listPlatformCoursesHandler);
  return app.request("/api/platform/courses", {}, { DATABASE_URL: "ignored" } as Env);
}

function postInstructor(superAdmin: boolean, courseId: string, body: unknown) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("authContext", fakeAuthContext({ isSuperAdmin: superAdmin })); await next(); });
  app.post("/api/platform/courses/:courseId/instructors", addCourseInstructorHandler);
  return app.request(`/api/platform/courses/${courseId}/instructors`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }, { DATABASE_URL: "ignored" } as Env);
}

beforeEach(() => {
  listPlatformCoursesMock.mockReset().mockResolvedValue([]);
});

describe("GET /api/platform/courses", () => {
  it("returns every deployment course to a super admin", async () => {
    listPlatformCoursesMock.mockResolvedValueOnce([{ id: "course-1", title: "Statistics", code: "STAT 311", term: "Autumn 2026", status: "active", instructors: [] }]);
    const response = await get(true);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ courses: [{ id: "course-1", title: "Statistics", code: "STAT 311", term: "Autumn 2026", status: "active", instructors: [] }] });
  });

  it("denies course listing to a non-super-admin", async () => {
    expect((await get(false)).status).toBe(403);
  });
});

describe("POST /api/platform/courses", () => {
  beforeEach(() => {
    provisionMock.mockReset().mockResolvedValue({
      status: "created", course: { id: "course-1", title: "Statistics", code: "STAT 311", term: "Autumn 2026" },
      instructor: { userId: "user-2", email: "prof@uw.edu" },
      organizationId: "org-1",
      membershipId: "membership-1",
      platformInstructorGrantCreated: true,
    });
    auditBestEffortMock.mockReset().mockResolvedValue(undefined);
  });

  it("is super-admin only", async () => {
    expect((await post(false, { instructorEmail: "prof@uw.edu", title: "Statistics", code: "STAT 311", term: "Autumn 2026" })).status).toBe(403);
    expect(provisionMock).not.toHaveBeenCalled();
  });

  it("normalizes and provisions a course shell", async () => {
    const response = await post(true, { instructorEmail: " Prof@UW.edu ", title: " Statistics ", code: " STAT 311 ", term: " Autumn 2026 " });
    expect(response.status).toBe(201);
    expect(provisionMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), "u1", {
      instructorEmail: "prof@uw.edu", title: "Statistics", code: "STAT 311", term: "Autumn 2026",
    });
    expect(auditBestEffortMock).toHaveBeenNthCalledWith(1, expect.anything(), ["org-1"], {
      actorUserId: "u1",
      action: "course.created",
      targetType: "course",
      targetId: "course-1",
      requestMetadata: { instructorUserId: "user-2" },
    });
    expect(auditBestEffortMock).toHaveBeenNthCalledWith(2, expect.anything(), ["org-1"], {
      actorUserId: "u1",
      action: "user.platform_instructor_granted",
      targetType: "user",
      targetId: "user-2",
    });
    expect(auditBestEffortMock).toHaveBeenNthCalledWith(3, expect.anything(), ["org-1"], {
      actorUserId: "u1",
      action: "membership.course_instructor_added",
      targetType: "membership",
      targetId: "membership-1",
      requestMetadata: { courseId: "course-1", instructorUserId: "user-2" },
    });
  });

  it("does not claim a new platform grant when the instructor was already granted", async () => {
    provisionMock.mockResolvedValue({
      status: "created", course: { id: "course-2", title: "Statistics II", code: "STAT 312", term: "Winter 2027" },
      instructor: { userId: "user-2", email: "prof@uw.edu" },
      organizationId: "org-1",
      membershipId: "membership-2",
      platformInstructorGrantCreated: false,
    });
    expect((await post(true, { instructorEmail: "prof@uw.edu", title: "Statistics II", code: "STAT 312", term: "Winter 2027" })).status).toBe(201);
    expect(auditBestEffortMock).toHaveBeenCalledTimes(2);
    expect(auditBestEffortMock.mock.calls.map((call) => call[2].action)).toEqual([
      "course.created",
      "membership.course_instructor_added",
    ]);
  });

  it.each([
    { instructorEmail: "bad", title: "Statistics", code: "STAT 311", term: "Autumn 2026" },
    { instructorEmail: "prof@uw.edu", title: "", code: "STAT 311", term: "Autumn 2026" },
    { instructorEmail: "prof@uw.edu", title: "Statistics", code: "", term: "Autumn 2026" },
    { instructorEmail: "prof@uw.edu", title: "Statistics", code: "STAT 311", term: "" },
  ])("rejects invalid input", async (body) => {
    expect((await post(true, body)).status).toBe(400);
    expect(provisionMock).not.toHaveBeenCalled();
  });

  it.each(["organization_missing", "duplicate_course"])("maps %s to conflict", async (status) => {
    provisionMock.mockResolvedValue({ status });
    expect((await post(true, { instructorEmail: "prof@uw.edu", title: "Statistics", code: "STAT 311", term: "Autumn 2026" })).status).toBe(409);
  });

  it("maps a disallowed instructor email to validation failure", async () => {
    provisionMock.mockResolvedValue({ status: "invalid_email", message: "Domain is not allowed" });
    expect((await post(true, { instructorEmail: "prof@gmail.com", title: "Statistics", code: "STAT 311", term: "Autumn 2026" })).status).toBe(400);
  });
});

describe("POST /api/platform/courses/:courseId/instructors", () => {
  beforeEach(() => {
    addInstructorMock.mockReset().mockResolvedValue({
      status: "assigned",
      instructor: { userId: "user-3", email: "second@uw.edu" },
      organizationId: "org-1",
      membershipId: "membership-3",
      membershipAdded: true,
      platformInstructorGrantCreated: true,
    });
    auditBestEffortMock.mockReset().mockResolvedValue(undefined);
  });

  it("is super-admin only", async () => {
    expect((await postInstructor(false, "course-1", { instructorEmail: "second@uw.edu" })).status).toBe(403);
    expect(addInstructorMock).not.toHaveBeenCalled();
  });

  it("normalizes the email and audits a new grant and course membership", async () => {
    const response = await postInstructor(true, "course-1", { instructorEmail: " Second@UW.edu " });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      instructor: { userId: "user-3", email: "second@uw.edu" },
      membershipAdded: true,
    });
    expect(addInstructorMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "u1",
      "course-1",
      "second@uw.edu",
    );
    expect(auditBestEffortMock).toHaveBeenCalledTimes(2);
    expect(auditBestEffortMock.mock.calls.map((call) => call[2])).toEqual([
      {
        actorUserId: "u1",
        action: "user.platform_instructor_granted",
        targetType: "user",
        targetId: "user-3",
      },
      {
        actorUserId: "u1",
        action: "membership.course_instructor_added",
        targetType: "membership",
        targetId: "membership-3",
        requestMetadata: { courseId: "course-1", instructorUserId: "user-3" },
      },
    ]);
  });

  it("returns idempotent success and writes no misleading audits", async () => {
    addInstructorMock.mockResolvedValueOnce({
      status: "assigned",
      instructor: { userId: "user-3", email: "second@uw.edu" },
      organizationId: "org-1",
      membershipId: "membership-3",
      membershipAdded: false,
      platformInstructorGrantCreated: false,
    });

    const response = await postInstructor(true, "course-1", { instructorEmail: "second@uw.edu" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      instructor: { userId: "user-3", email: "second@uw.edu" },
      membershipAdded: false,
    });
    expect(auditBestEffortMock).not.toHaveBeenCalled();
  });

  it.each([
    null,
    {},
    { instructorEmail: "" },
    { instructorEmail: "bad" },
    { instructorEmail: "prof@.uw.edu" },
    { instructorEmail: "prof@sub..uw.edu" },
    { instructorEmail: "first..last@uw.edu" },
    { instructorEmail: "prof()@uw.edu" },
    { instructorEmail: "prof@-sub.uw.edu" },
  ])("rejects an invalid request body", async (body) => {
    expect((await postInstructor(true, "course-1", body)).status).toBe(400);
    expect(addInstructorMock).not.toHaveBeenCalled();
  });

  it("maps an unknown course to not found", async () => {
    addInstructorMock.mockResolvedValueOnce({ status: "course_missing" });
    expect((await postInstructor(true, "missing", { instructorEmail: "second@uw.edu" })).status).toBe(404);
  });

  it("maps a disallowed email to validation failure", async () => {
    addInstructorMock.mockResolvedValueOnce({ status: "invalid_email", message: "Domain is not allowed" });
    const response = await postInstructor(true, "course-1", { instructorEmail: "second@gmail.com" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Domain is not allowed" });
  });

  it("audits only the membership when the platform grant already existed", async () => {
    addInstructorMock.mockResolvedValueOnce({
      status: "assigned",
      instructor: { userId: "user-3", email: "second@uw.edu" },
      organizationId: "org-1",
      membershipId: "membership-3",
      membershipAdded: true,
      platformInstructorGrantCreated: false,
    });
    expect((await postInstructor(true, "course-1", { instructorEmail: "second@uw.edu" })).status).toBe(201);
    expect(auditBestEffortMock).toHaveBeenCalledTimes(1);
    expect(auditBestEffortMock.mock.calls[0]![2].action).toBe("membership.course_instructor_added");
  });
});
