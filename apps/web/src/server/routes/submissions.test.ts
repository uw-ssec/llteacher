import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { submitSectionHandler } from "./submissions";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import type { SubmissionResponse } from "../../shared/types";

const TEST_ENV = { DATABASE_URL: "ignored" } as Env;
const submitSectionMock = vi.fn();
const getOrgScopesForUserMock = vi.fn();
vi.mock("../repositories/submissions", () => ({ submitSection: (...a: unknown[]) => submitSectionMock(...a) }));
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
