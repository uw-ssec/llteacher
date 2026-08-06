import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { submitSectionHandler, getHomeworkSubmissionsHandler } from "./submissions";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import type { SubmissionResponse } from "../../shared/types";

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
vi.mock("../repositories/submissions", () => ({
  submitSection: (...a: unknown[]) => submitSectionMock(...a),
  getHomeworkSubmissionsMatrix: (...a: unknown[]) => getHomeworkSubmissionsMatrixMock(...a),
}));
vi.mock("../repositories/users", () => ({ getOrgScopesForUser: (...a: unknown[]) => getOrgScopesForUserMock(...a) }));
vi.mock("../../db/client", () => ({ makeDb: () => ({}) }));

function fakeAuthContext(overrides: Partial<AuthContext> = {}): AuthContext {
  const memberships = overrides.memberships ?? [];
  return {
    session: { userId: "u1", workosUserId: "w1", sessionEpoch: 0, issuedAt: 0, expiresAt: 0 },
    memberships, hasRole: (r) => memberships.some((m) => m.role === r),
    isMemberOf: () => false, isInstructorOf: () => false, ...overrides,
  };
}
function buildApp(authContext: AuthContext | undefined) {
  const app = new Hono<AppEnv>();
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

  it("maps a wrong-owner repository error to 403", async () => {
    getOrgScopesForUserMock.mockReset().mockResolvedValue(["org-1"]);
    submitSectionMock.mockReset().mockRejectedValue(new Error("Conversation not found or not owned by requester"));
    const res = await buildApp(fakeAuthContext({ hasRole: (r) => r === "student" })).request(
      "/api/conversations/conv-1/submit", { method: "POST" }, TEST_ENV,
    );
    expect(res.status).toBe(403);
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
    ).request("/api/courses/course-a/homeworks/hw-1/submissions", {}, TEST_ENV);
    expect(res.status).toBe(403);
  });

  it("denies a student with 403", async () => {
    const res = await buildSubmissionsApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: () => false, hasRole: (r) => r === "student" }),
    ).request("/api/courses/course-a/homeworks/hw-1/submissions", {}, TEST_ENV);
    expect(res.status).toBe(403);
  });

  it("returns the matrix for an instructor of the course", async () => {
    getHomeworkSubmissionsMatrixMock.mockReset().mockResolvedValue({
      homeworkId: "hw-1", homeworkTitle: "HW 1", homeworkDueDate: "2099-01-01T00:00:00.000Z",
      sectionHeaders: [], students: [],
      aggregateStats: { totalStudents: 0, activeStudents: 0, inactiveStudents: 0, totalSubmissions: 0, submissionRate: 0 },
    });
    const res = await buildSubmissionsApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" }),
    ).request("/api/courses/course-a/homeworks/hw-1/submissions", {}, TEST_ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { homeworkId: string };
    expect(body.homeworkId).toBe("hw-1");
  });

  it("returns 404 when the homework isn't found in scope", async () => {
    getHomeworkSubmissionsMatrixMock.mockReset().mockResolvedValue(null);
    const res = await buildSubmissionsApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" }),
    ).request("/api/courses/course-a/homeworks/hw-1/submissions", {}, TEST_ENV);
    expect(res.status).toBe(404);
  });
});
