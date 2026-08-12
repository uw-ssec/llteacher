import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { submitSectionHandler, getHomeworkSubmissionsHandler } from "./submissions";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import type { SubmissionResponse } from "../../shared/types";
import { fakeAuthContext, fakeMembership } from "../testing/authContext";

// ENCRYPTION_KEY/BLIND_INDEX_KEY (real, random) let getHomeworkSubmissionsHandler
// construct a real IdentityCipher via loadIdentityCipherKeys -- same
// TEST_ENV-extension approach as profile.test.ts, rather than mocking
// secrets-loader/identity-cipher on top of the already-mocked repository
// call (getHomeworkSubmissionsMatrix, mocked below, never actually invokes
// the cipher's decrypt methods in these tests).
const TEST_ENV = {
  DATABASE_URL: "ignored",
  ENCRYPTION_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
  BLIND_INDEX_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
} as Env;
const submitSectionMock = vi.fn();
const getOrgScopesForUserMock = vi.fn();
const getHomeworkSubmissionsMatrixMock = vi.fn();
vi.mock("../repositories/submissions", async (importOriginal) => {
  // importOriginal, not a bare factory: the handler now narrows on
  // TeacherTestNotSubmittableError (#242), and a factory that omits the class
  // makes `err instanceof undefined` throw inside the catch block.
  const actual = await importOriginal<typeof import("../repositories/submissions")>();
  return {
    ...actual,
    submitSection: (...a: unknown[]) => submitSectionMock(...a),
    getHomeworkSubmissionsMatrix: (...a: unknown[]) => getHomeworkSubmissionsMatrixMock(...a),
  };
});
vi.mock("../repositories/users", () => ({ getOrgScopesForUser: (...a: unknown[]) => getOrgScopesForUserMock(...a) }));
vi.mock("../../db/client", () => ({ makeDb: () => ({}) }));

/** Mirrors server/index.ts's app.onError so a rethrown error is observed the
 *  way production observes it -- logged, and answered with the generic 503.
 *  Without it the test app reports Hono's default 500 and the distinction
 *  #251 is about would not actually be under test. */
function buildApp(authContext: AuthContext | undefined) {
  const app = new Hono<AppEnv>();
  app.onError((_err, c) => c.json({ error: "SERVICE_UNAVAILABLE" }, 503));
  app.use("*", async (c, next) => { if (authContext) c.set("authContext", authContext); await next(); });
  app.post("/api/conversations/:id/submit", (c) => submitSectionHandler(c));
  return app;
}

describe("POST /api/conversations/:id/submit", () => {
  it("denies a non-student with 403", async () => {
    const res = await buildApp(fakeAuthContext({ hasRole: () => false })).request(
      "/api/conversations/conv-1/submit", { method: "POST" }, TEST_ENV,
    );
    expect(res.status).toBe(403);
  });

  it("creates a submission and returns 201, isResubmission=false", async () => {
    getOrgScopesForUserMock.mockReset().mockResolvedValue(["org-1"]);
    submitSectionMock.mockReset().mockResolvedValue({ id: "sub-1", conversationId: "conv-1", submittedAt: new Date(), isResubmission: false });
    const res = await buildApp(fakeAuthContext({ hasRole: (r) => r === "student" })).request(
      "/api/conversations/conv-1/submit", { method: "POST" }, TEST_ENV,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as SubmissionResponse;
    expect(body.isResubmission).toBe(false);
  });

  it("resubmit returns 200, isResubmission=true", async () => {
    getOrgScopesForUserMock.mockReset().mockResolvedValue(["org-1"]);
    submitSectionMock.mockReset().mockResolvedValue({ id: "sub-1", conversationId: "conv-1", submittedAt: new Date(), isResubmission: true });
    const res = await buildApp(fakeAuthContext({ hasRole: (r) => r === "student" })).request(
      "/api/conversations/conv-1/submit", { method: "POST" }, TEST_ENV,
    );
    expect(res.status).toBe(200);
  });

  it.each(["ConversationNotSubmittableError", "NotSubmissionOwnerError"] as const)(
    "collapses %s into the same opaque 403",
    async (errorName) => {
      const mod = await import("../repositories/submissions");
      getOrgScopesForUserMock.mockReset().mockResolvedValue(["org-1"]);
      submitSectionMock.mockReset().mockRejectedValue(new mod[errorName]());
      const res = await buildApp(fakeAuthContext({ hasRole: (r) => r === "student" })).request(
        "/api/conversations/conv-1/submit", { method: "POST" }, TEST_ENV,
      );
      expect(res.status).toBe(403);
      // Identical body either way -- a non-owner must not be able to tell
      // "doesn't exist" from "not yours" and learn a conversation exists.
      expect(((await res.json()) as { error: string }).error).toBe(
        "Conversation not found or not accessible",
      );
    },
  );

  it("returns 409 when the homework is hidden or expired (#251)", async () => {
    const { HomeworkClosedError } = await import("../repositories/submissions");
    getOrgScopesForUserMock.mockReset().mockResolvedValue(["org-1"]);
    submitSectionMock.mockReset().mockRejectedValue(new HomeworkClosedError());
    const res = await buildApp(fakeAuthContext({ hasRole: (r) => r === "student" })).request(
      "/api/conversations/conv-1/submit", { method: "POST" }, TEST_ENV,
    );
    // The student had legitimate access -- "not found" would send them
    // hunting a bug that isn't there.
    expect(res.status).toBe(409);
  });

  it("lets an unexpected repository failure propagate instead of reporting 403 (#251)", async () => {
    // The gap @KshitijDani found: this catch was edited for #242 without
    // taking #236's standard with it, so a dropped connection was reported
    // to the student as "not found or not accessible" and never logged.
    getOrgScopesForUserMock.mockReset().mockResolvedValue(["org-1"]);
    submitSectionMock.mockReset().mockRejectedValue(new Error("connection terminated unexpectedly"));
    const res = await buildApp(fakeAuthContext({ hasRole: (r) => r === "student" })).request(
      "/api/conversations/conv-1/submit", { method: "POST" }, TEST_ENV,
    );
    expect(res.status).toBe(503);
  });
});

describe("GET /api/courses/:courseId/homeworks/:homeworkId/submissions", () => {
  function buildSubmissionsApp(authContext: AuthContext | undefined) {
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => { if (authContext) c.set("authContext", authContext); await next(); });
    app.get("/api/courses/:courseId/homeworks/:homeworkId/submissions", (c) => getHomeworkSubmissionsHandler(c));
    return app;
  }

  it("denies a non-instructor with 403", async () => {
    const res = await buildSubmissionsApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: () => false }),
    ).request("/api/courses/course-a/homeworks/11111111-2222-4333-8444-555555555555/submissions", {}, TEST_ENV);
    expect(res.status).toBe(403);
  });

  it("denies a student with 403", async () => {
    const res = await buildSubmissionsApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: () => false, hasRole: (r) => r === "student" }),
    ).request("/api/courses/course-a/homeworks/11111111-2222-4333-8444-555555555555/submissions", {}, TEST_ENV);
    expect(res.status).toBe(403);
  });

  it("returns the matrix for an instructor of the course", async () => {
    getHomeworkSubmissionsMatrixMock.mockReset().mockResolvedValue({
      homeworkId: "hw-1", homeworkTitle: "HW 1", homeworkDueDate: "2099-01-01T00:00:00.000Z",
      sectionHeaders: [], students: [],
      aggregateStats: { totalStudents: 0, activeStudents: 0, inactiveStudents: 0, totalSubmissions: 0, submissionRate: 0 },
    });
    const res = await buildSubmissionsApp(
      fakeAuthContext({ memberships: [fakeMembership({ courseId: "course-a", role: "instructor" })] }),
    ).request("/api/courses/course-a/homeworks/11111111-2222-4333-8444-555555555555/submissions", {}, TEST_ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { homeworkId: string };
    expect(body.homeworkId).toBe("hw-1");
  });

  it("returns 404 when the homework isn't found in scope", async () => {
    getHomeworkSubmissionsMatrixMock.mockReset().mockResolvedValue(null);
    const res = await buildSubmissionsApp(
      fakeAuthContext({ memberships: [fakeMembership({ courseId: "course-a", role: "instructor" })] }),
    ).request("/api/courses/course-a/homeworks/11111111-2222-4333-8444-555555555555/submissions", {}, TEST_ENV);
    expect(res.status).toBe(404);
  });
});

/** #172: the submissions dashboard is grading, not authoring -- a TA of the
 *  course may read it, and needs no capability grant to do so. The grants
 *  govern solutions and unreleased content, not student work. */
describe("GET .../submissions — grader access (#172)", () => {
  function buildSubmissionsApp(authContext: AuthContext | undefined) {
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => { if (authContext) c.set("authContext", authContext); await next(); });
    app.get("/api/courses/:courseId/homeworks/:homeworkId/submissions", (c) => getHomeworkSubmissionsHandler(c));
    return app;
  }

  const MATRIX = {
    homeworkId: "hw-1", homeworkTitle: "HW 1", homeworkDueDate: "2099-01-01T00:00:00.000Z",
    sectionHeaders: [], students: [], missingSectionWarnings: [],
    aggregateStats: { totalStudents: 0, activeStudents: 0, inactiveStudents: 0, totalSubmissions: 0, submissionRate: 0 },
  };

  it("allows a TA with no capability grants at all", async () => {
    getHomeworkSubmissionsMatrixMock.mockReset().mockResolvedValue(MATRIX);
    const res = await buildSubmissionsApp(
      fakeAuthContext({ memberships: [fakeMembership({ courseId: "course-a", role: "ta" })] }),
    ).request("/api/courses/course-a/homeworks/11111111-2222-4333-8444-555555555555/submissions", {}, TEST_ENV);
    expect(res.status).toBe(200);
  });

  it("denies a student of the same course", async () => {
    getHomeworkSubmissionsMatrixMock.mockReset().mockResolvedValue(MATRIX);
    const res = await buildSubmissionsApp(
      fakeAuthContext({ memberships: [fakeMembership({ courseId: "course-a", role: "student" })] }),
    ).request("/api/courses/course-a/homeworks/11111111-2222-4333-8444-555555555555/submissions", {}, TEST_ENV);
    expect(res.status).toBe(403);
  });

  it("denies a TA of a different course", async () => {
    getHomeworkSubmissionsMatrixMock.mockReset().mockResolvedValue(MATRIX);
    const res = await buildSubmissionsApp(
      fakeAuthContext({ memberships: [fakeMembership({ courseId: "course-b", role: "ta" })] }),
    ).request("/api/courses/course-a/homeworks/11111111-2222-4333-8444-555555555555/submissions", {}, TEST_ENV);
    expect(res.status).toBe(403);
    expect(getHomeworkSubmissionsMatrixMock).not.toHaveBeenCalled();
  });
});

/** #172 audit (SEC-001): grading authority does not carry access to content
 *  the instructor has withdrawn from release. Before this gate, a TA denied
 *  can_view_drafts could still read a hidden homework's title, due date and
 *  section titles here -- content getHomeworkDetailHandler 404s them for. */
describe("GET .../submissions — unreleased-content gate (#172 audit)", () => {
  function buildSubmissionsApp(authContext: AuthContext | undefined) {
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => { if (authContext) c.set("authContext", authContext); await next(); });
    app.get("/api/courses/:courseId/homeworks/:homeworkId/submissions", (c) => getHomeworkSubmissionsHandler(c));
    return app;
  }
  const matrixWith = (homeworkStatus: string) => ({
    homeworkId: "hw-1", homeworkStatus, homeworkTitle: "Secret HW",
    homeworkDueDate: "2099-01-01T00:00:00.000Z",
    sectionHeaders: [{ id: "s1", order: 1, title: "Unreleased section" }],
    students: [], missingSectionWarnings: [],
    aggregateStats: { totalStudents: 0, activeStudents: 0, inactiveStudents: 0, totalSubmissions: 0, submissionRate: 0 },
  });
  const req = (ctx: AuthContext) =>
    buildSubmissionsApp(ctx).request("/api/courses/course-a/homeworks/11111111-2222-4333-8444-555555555555/submissions", {}, TEST_ENV);

  it.each(["draft", "scheduled", "hidden"])("404s %s for an ungranted TA", async (status) => {
    getHomeworkSubmissionsMatrixMock.mockReset().mockResolvedValue(matrixWith(status));
    const res = await req(
      fakeAuthContext({ memberships: [fakeMembership({ courseId: "course-a", role: "ta" })] }),
    );
    expect(res.status).toBe(404);
  });

  it("returns a hidden homework to a TA granted canViewDrafts", async () => {
    getHomeworkSubmissionsMatrixMock.mockReset().mockResolvedValue(matrixWith("hidden"));
    const res = await req(
      fakeAuthContext({
        memberships: [fakeMembership({ courseId: "course-a", role: "ta", canViewDrafts: true })],
      }),
    );
    expect(res.status).toBe(200);
  });

  it("returns a hidden homework to an instructor unconditionally", async () => {
    getHomeworkSubmissionsMatrixMock.mockReset().mockResolvedValue(matrixWith("hidden"));
    const res = await req(
      fakeAuthContext({ memberships: [fakeMembership({ courseId: "course-a", role: "instructor" })] }),
    );
    expect(res.status).toBe(200);
  });

  it("still returns an active homework to an ungranted TA", async () => {
    getHomeworkSubmissionsMatrixMock.mockReset().mockResolvedValue(matrixWith("active"));
    const res = await req(
      fakeAuthContext({ memberships: [fakeMembership({ courseId: "course-a", role: "ta" })] }),
    );
    expect(res.status).toBe(200);
  });
});

describe("POST /api/conversations/:id/submit — teacher test (#242)", () => {
  it("returns 409 naming the real reason, not the uniform 403", async () => {
    const { TeacherTestNotSubmittableError } = await import("../repositories/submissions");
    submitSectionMock.mockReset().mockRejectedValue(new TeacherTestNotSubmittableError());
    getOrgScopesForUserMock.mockReset().mockResolvedValue(["org-1"]);

    const res = await buildApp(
      fakeAuthContext({ memberships: [fakeMembership({ courseId: "course-a", role: "student" })] }),
    ).request("/api/conversations/11111111-2222-4333-8444-555555555555/submit", { method: "POST" }, TEST_ENV);

    // The caller owns this conversation -- it is their own test run -- so
    // "not found or not accessible" would simply be false, and naming the
    // real reason leaks nothing.
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/Teacher test/);
  });
});
