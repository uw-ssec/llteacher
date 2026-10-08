import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../context";
import { fakeAuthContext } from "../testing/authContext";
import { provisionCourseHandler } from "./courseProvisioning";

const provisionMock = vi.fn();
const getOrgScopeForCourseMock = vi.fn();
const auditBestEffortMock = vi.fn();
vi.mock("../repositories/courseProvisioning", () => ({ provisionInstructorCourse: (...a: unknown[]) => provisionMock(...a) }));
vi.mock("../repositories/organizations", () => ({ getOrgScopeForCourse: (...a: unknown[]) => getOrgScopeForCourseMock(...a) }));
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

describe("POST /api/platform/courses", () => {
  beforeEach(() => {
    provisionMock.mockReset().mockResolvedValue({
      status: "created", course: { id: "course-1", title: "Statistics", code: "STAT 311", term: "Autumn 2026" },
      instructor: { userId: "user-2", email: "prof@uw.edu" },
      membershipId: "membership-1",
      platformInstructorGrantCreated: true,
    });
    getOrgScopeForCourseMock.mockReset().mockResolvedValue("org-1");
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
