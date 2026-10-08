import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { submitWidgetResponseHandler } from "./progressWidgets";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import type { WidgetResponseResponse } from "../../shared/types";
import { fakeAuthContext } from "../testing/authContext";
import { WidgetNotFoundError } from "../repositories/progressWidgets";

const TEST_ENV = { DATABASE_URL: "ignored" } as Env;
/** A syntactically valid widget id. These tests used to pass "w-1", which
 *  only reached the (mocked) repository because the handler had no UUID
 *  guard; in production it raised Postgres's `invalid input syntax`. */
const WIDGET_PATH = "/api/widgets/11111111-2222-4333-8444-555555555555/response";

const submitWidgetResponseMock = vi.fn();
// importOriginal, not a bare factory: the handler now names
// WidgetNotFoundError, which a factory omitting it would leave undefined.
vi.mock("../repositories/progressWidgets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repositories/progressWidgets")>();
  return { ...actual, submitWidgetResponse: (...a: unknown[]) => submitWidgetResponseMock(...a) };
});
const getOrgScopesForUserMock = vi.fn();
vi.mock("../repositories/users", () => ({ getOrgScopesForUser: (...a: unknown[]) => getOrgScopesForUserMock(...a) }));
vi.mock("../../db/client", () => ({ makeDb: () => ({}) }));


function buildApp(authContext: AuthContext | undefined) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { if (authContext) c.set("authContext", authContext); await next(); });
  app.patch("/api/widgets/:widgetId/response", (c) => submitWidgetResponseHandler(c));
  return app;
}

describe("PATCH /api/widgets/:widgetId/response", () => {
  it("denies a non-student with 403", async () => {
    const res = await buildApp(fakeAuthContext({ hasRole: () => false })).request(
      WIDGET_PATH,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ which: "pre", value: 5 }) },
      TEST_ENV,
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 when which is missing/invalid", async () => {
    const res = await buildApp(fakeAuthContext({ hasRole: (r) => r === "student" })).request(
      WIDGET_PATH,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ which: "sideways", value: 5 }) },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when value is out of the 0-10 range", async () => {
    const res = await buildApp(fakeAuthContext({ hasRole: (r) => r === "student" })).request(
      WIDGET_PATH,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ which: "pre", value: 11 }) },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when value is not an integer", async () => {
    const res = await buildApp(fakeAuthContext({ hasRole: (r) => r === "student" })).request(
      WIDGET_PATH,
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
      WIDGET_PATH,
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
    submitWidgetResponseMock.mockReset().mockRejectedValue(new WidgetNotFoundError());
    const res = await buildApp(fakeAuthContext({ hasRole: (r) => r === "student" })).request(
      WIDGET_PATH,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ which: "pre", value: 5 }) },
      TEST_ENV,
    );
    expect(res.status).toBe(403);
  });

  it("returns 403 when the caller has no organization membership", async () => {
    getOrgScopesForUserMock.mockReset().mockResolvedValue([]);
    const res = await buildApp(fakeAuthContext({ hasRole: (r) => r === "student" })).request(
      WIDGET_PATH,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ which: "pre", value: 5 }) },
      TEST_ENV,
    );
    expect(res.status).toBe(403);
  });

  it("answers 503, not the refusal 403, when the database fails", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    getOrgScopesForUserMock.mockReset().mockResolvedValue(["org-1"]);
    submitWidgetResponseMock.mockReset().mockRejectedValue(
      Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    );
    const res = await buildApp(fakeAuthContext({ hasRole: (r) => r === "student" })).request(
      WIDGET_PATH,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ which: "pre", value: 5 }) },
      TEST_ENV,
    );
    expect(res.status).toBe(503);
    consoleSpy.mockRestore();
  });

  it("refuses a malformed widgetId with the same 403, without touching the database", async () => {
    getOrgScopesForUserMock.mockReset();
    submitWidgetResponseMock.mockReset();
    const res = await buildApp(fakeAuthContext({ hasRole: (r) => r === "student" })).request(
      "/api/widgets/w-1/response",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ which: "pre", value: 5 }) },
      TEST_ENV,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Widget not found in this org scope" });
    expect(getOrgScopesForUserMock).not.toHaveBeenCalled();
    expect(submitWidgetResponseMock).not.toHaveBeenCalled();
  });
});
