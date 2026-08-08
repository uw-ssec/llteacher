import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { submitWidgetResponseHandler } from "./progressWidgets";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import type { WidgetResponseResponse } from "../../shared/types";

const TEST_ENV = { DATABASE_URL: "ignored" } as Env;

const submitWidgetResponseMock = vi.fn();
vi.mock("../repositories/progressWidgets", () => ({
  submitWidgetResponse: (...a: unknown[]) => submitWidgetResponseMock(...a),
}));
const getOrgScopesForUserMock = vi.fn();
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
  app.patch("/api/widgets/:widgetId/response", (c) => submitWidgetResponseHandler(c));
  return app;
}

describe("PATCH /api/widgets/:widgetId/response", () => {
  it("denies a non-student with 403", async () => {
    const res = await buildApp(fakeAuthContext({ hasRole: () => false })).request(
      "/api/widgets/w-1/response",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ which: "pre", value: 5 }) },
      TEST_ENV,
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 when which is missing/invalid", async () => {
    const res = await buildApp(fakeAuthContext({ hasRole: (r) => r === "student" })).request(
      "/api/widgets/w-1/response",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ which: "sideways", value: 5 }) },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when value is out of the 0-10 range", async () => {
    const res = await buildApp(fakeAuthContext({ hasRole: (r) => r === "student" })).request(
      "/api/widgets/w-1/response",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ which: "pre", value: 11 }) },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when value is not an integer", async () => {
    const res = await buildApp(fakeAuthContext({ hasRole: (r) => r === "student" })).request(
      "/api/widgets/w-1/response",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ which: "pre", value: 5.5 }) },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
  });

  it("submits a pre value and returns the response", async () => {
    getOrgScopesForUserMock.mockReset().mockResolvedValue(["org-1"]);
    submitWidgetResponseMock.mockReset().mockResolvedValue({
      id: "resp-1", widgetId: "w-1", userId: "u1",
      preValue: 7, preSubmittedAt: new Date("2026-01-01T00:00:00.000Z"),
      postValue: null, postSubmittedAt: null,
    });
    const res = await buildApp(fakeAuthContext({ hasRole: (r) => r === "student" })).request(
      "/api/widgets/w-1/response",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ which: "pre", value: 7 }) },
      TEST_ENV,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as WidgetResponseResponse;
    expect(body.preValue).toBe(7);
    expect(body.postValue).toBeNull();
  });

  it("maps a not-found-in-org repository error to 403", async () => {
    getOrgScopesForUserMock.mockReset().mockResolvedValue(["org-1"]);
    submitWidgetResponseMock.mockReset().mockRejectedValue(new Error("Widget not found in this org scope"));
    const res = await buildApp(fakeAuthContext({ hasRole: (r) => r === "student" })).request(
      "/api/widgets/w-1/response",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ which: "pre", value: 5 }) },
      TEST_ENV,
    );
    expect(res.status).toBe(403);
  });

  it("returns 403 when the caller has no organization membership", async () => {
    getOrgScopesForUserMock.mockReset().mockResolvedValue([]);
    const res = await buildApp(fakeAuthContext({ hasRole: (r) => r === "student" })).request(
      "/api/widgets/w-1/response",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ which: "pre", value: 5 }) },
      TEST_ENV,
    );
    expect(res.status).toBe(403);
  });
});
