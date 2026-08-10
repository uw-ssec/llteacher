import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { submitSectionAnswerHandler, getSectionAnswerHandler } from "./sectionAnswers";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import type { SectionAnswerResponse } from "../../shared/types";
import { fakeAuthContext, fakeMembership } from "../testing/authContext";

const TEST_ENV = { DATABASE_URL: "ignored" } as Env;

const upsertSectionAnswerMock = vi.fn();
const getSectionAnswerMock = vi.fn();
vi.mock("../repositories/sectionAnswers", () => ({
  upsertSectionAnswer: (...a: unknown[]) => upsertSectionAnswerMock(...a),
  getSectionAnswer: (...a: unknown[]) => getSectionAnswerMock(...a),
}));
const getOrgScopesForUserMock = vi.fn();
vi.mock("../repositories/users", () => ({ getOrgScopesForUser: (...a: unknown[]) => getOrgScopesForUserMock(...a) }));
vi.mock("../../db/client", () => ({ makeDb: () => ({}) }));


function buildApp(authContext: AuthContext | undefined) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { if (authContext) c.set("authContext", authContext); await next(); });
  app.patch("/api/sections/:sectionId/answer", (c) => submitSectionAnswerHandler(c));
  app.get("/api/courses/:courseId/sections/:sectionId/answers/:studentId", (c) => getSectionAnswerHandler(c));
  return app;
}

describe("PATCH /api/sections/:sectionId/answer", () => {
  it("denies a non-student with 403", async () => {
    const res = await buildApp(fakeAuthContext({ hasRole: () => false })).request(
      "/api/sections/sec-1/answer",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "x" }) },
      TEST_ENV,
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 when content is missing or empty", async () => {
    const res = await buildApp(fakeAuthContext({ hasRole: (r) => r === "student" })).request(
      "/api/sections/sec-1/answer",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "   " }) },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
  });

  it("submits and returns the answer", async () => {
    getOrgScopesForUserMock.mockReset().mockResolvedValue(["org-1"]);
    upsertSectionAnswerMock.mockReset().mockResolvedValue({
      id: "ans-1", sectionId: "sec-1", userId: "u1", content: "my answer",
      submittedAt: new Date("2026-01-01T00:00:00.000Z"), updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const res = await buildApp(fakeAuthContext({ hasRole: (r) => r === "student" })).request(
      "/api/sections/sec-1/answer",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "my answer" }) },
      TEST_ENV,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SectionAnswerResponse;
    expect(body.content).toBe("my answer");
    expect(body.sectionId).toBe("sec-1");
  });

  it("maps a conversation-type-section repository error to 403", async () => {
    getOrgScopesForUserMock.mockReset().mockResolvedValue(["org-1"]);
    upsertSectionAnswerMock.mockReset().mockRejectedValue(new Error("Section does not accept a direct answer"));
    const res = await buildApp(fakeAuthContext({ hasRole: (r) => r === "student" })).request(
      "/api/sections/sec-1/answer",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "x" }) },
      TEST_ENV,
    );
    expect(res.status).toBe(403);
  });

  it("returns 403 when the caller has no organization membership", async () => {
    getOrgScopesForUserMock.mockReset().mockResolvedValue([]);
    const res = await buildApp(fakeAuthContext({ hasRole: (r) => r === "student" })).request(
      "/api/sections/sec-1/answer",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "x" }) },
      TEST_ENV,
    );
    expect(res.status).toBe(403);
  });
});

describe("GET /api/courses/:courseId/sections/:sectionId/answers/:studentId", () => {
  it("denies a non-instructor with 403", async () => {
    const res = await buildApp(fakeAuthContext({ isInstructorOf: () => false })).request(
      "/api/courses/course-a/sections/sec-1/answers/student-1", {}, TEST_ENV,
    );
    expect(res.status).toBe(403);
  });

  // #174: courseScopeFromAuthContext (real, unmocked -- pure function) only
  // mints a scope when isMemberOf(courseId) is true, so both success-path
  // tests below must set it alongside isInstructorOf.
  it("returns 403 when isInstructorOf passes but isMemberOf doesn't (should be unreachable in practice)", async () => {
    getSectionAnswerMock.mockReset();
    const res = await buildApp(fakeAuthContext({ memberships: [fakeMembership({ courseId: "course-a", role: "instructor" })], isMemberOf: () => false })).request(
      "/api/courses/course-a/sections/sec-1/answers/student-1", {}, TEST_ENV,
    );
    expect(res.status).toBe(403);
    expect(getSectionAnswerMock).not.toHaveBeenCalled();
  });

  it("returns 404 when no answer exists", async () => {
    getSectionAnswerMock.mockReset().mockResolvedValue(null);
    const res = await buildApp(fakeAuthContext({ memberships: [fakeMembership({ courseId: "course-a", role: "instructor" })] })).request(
      "/api/courses/course-a/sections/sec-1/answers/student-1", {}, TEST_ENV,
    );
    expect(res.status).toBe(404);
  });

  it("passes a course-scoped (not org-scoped) query down to the repository", async () => {
    getSectionAnswerMock.mockReset().mockResolvedValue(null);
    await buildApp(fakeAuthContext({ memberships: [fakeMembership({ courseId: "course-a", role: "instructor" })] })).request(
      "/api/courses/course-a/sections/sec-1/answers/student-1", {}, TEST_ENV,
    );
    expect(getSectionAnswerMock).toHaveBeenCalledWith(expect.anything(), "course-a", "sec-1", "student-1");
  });

  it("returns the found answer", async () => {
    getSectionAnswerMock.mockReset().mockResolvedValue({
      id: "ans-1", sectionId: "sec-1", userId: "student-1", content: "their answer",
      submittedAt: new Date("2026-01-01T00:00:00.000Z"), updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const res = await buildApp(fakeAuthContext({ memberships: [fakeMembership({ courseId: "course-a", role: "instructor" })] })).request(
      "/api/courses/course-a/sections/sec-1/answers/student-1", {}, TEST_ENV,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SectionAnswerResponse;
    expect(body.content).toBe("their answer");
    expect(body.userId).toBe("student-1");
  });
});

/** #172: reading one student's answer is grading, so a TA of the course may
 *  do it without any capability grant -- same rationale as the submissions
 *  dashboard. Cross-course isolation from #174 must still hold. */
describe("GET .../answers/:studentId — grader access (#172)", () => {
  it("allows a TA with no capability grants at all", async () => {
    getSectionAnswerMock.mockReset().mockResolvedValue({
      id: "a1", sectionId: "sec-1", userId: "stu-1", content: "my answer",
      submittedAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01"),
    });
    const res = await buildApp(
      fakeAuthContext({ memberships: [fakeMembership({ courseId: "course-a", role: "ta" })] }),
    ).request("/api/courses/course-a/sections/sec-1/answers/stu-1", {}, TEST_ENV);
    expect(res.status).toBe(200);
  });

  it("denies a TA of a different course", async () => {
    getSectionAnswerMock.mockReset();
    const res = await buildApp(
      fakeAuthContext({ memberships: [fakeMembership({ courseId: "course-b", role: "ta" })] }),
    ).request("/api/courses/course-a/sections/sec-1/answers/stu-1", {}, TEST_ENV);
    expect(res.status).toBe(403);
    expect(getSectionAnswerMock).not.toHaveBeenCalled();
  });

  it("denies a student of the same course", async () => {
    getSectionAnswerMock.mockReset();
    const res = await buildApp(
      fakeAuthContext({ memberships: [fakeMembership({ courseId: "course-a", role: "student" })] }),
    ).request("/api/courses/course-a/sections/sec-1/answers/stu-1", {}, TEST_ENV);
    expect(res.status).toBe(403);
  });
});
