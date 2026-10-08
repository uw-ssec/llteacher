import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../context";
import type { AuthContext } from "../middleware/roles";
import { fakeAuthContext } from "../testing/authContext";
import { createOrganizationHandler, getOrganizationHandler } from "./organizations";

const getOrganizationMock = vi.fn();
const createOrganizationMock = vi.fn();

vi.mock("../repositories/organizations", () => ({
  getDeploymentOrganization: (...args: unknown[]) => getOrganizationMock(...args),
  createDeploymentOrganization: (...args: unknown[]) => createOrganizationMock(...args),
}));
vi.mock("../../db/client", () => ({ makeDb: () => ({}) }));

function appFor(auth: AuthContext) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("authContext", auth); await next(); });
  app.get("/api/platform/organization", getOrganizationHandler);
  app.post("/api/platform/organization", createOrganizationHandler);
  return app;
}

function request(auth: AuthContext, body?: unknown) {
  return appFor(auth).request("/api/platform/organization", body === undefined ? {} : {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, { DATABASE_URL: "ignored" } as Env);
}

describe("platform organization routes", () => {
  beforeEach(() => {
    getOrganizationMock.mockReset().mockResolvedValue(null);
    createOrganizationMock.mockReset().mockResolvedValue({
      created: true,
      organization: { id: "org-1", name: "University of Washington", slug: "uw", allowedDomains: ["uw.edu"] },
    });
  });

  it("returns an empty first-run state to a super admin", async () => {
    const response = await request(fakeAuthContext({ isSuperAdmin: true }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ organization: null });
  });

  it("denies a regular instructor", async () => {
    const response = await request(fakeAuthContext());
    expect(response.status).toBe(403);
  });

  it("creates the deployment institution with normalized input and session provenance", async () => {
    const auth = fakeAuthContext({
      isSuperAdmin: true,
      session: { ...fakeAuthContext().session, workosOrganizationId: "workos-org-1" },
    });
    const response = await request(auth, {
      name: "  University of Washington ", slug: " UW ", allowedDomains: [" UW.EDU ", "uw.edu"],
    });
    expect(response.status).toBe(201);
    expect(createOrganizationMock).toHaveBeenCalledWith(expect.anything(), {
      name: "University of Washington", slug: "uw", allowedDomains: ["uw.edu"], workosOrganizationId: "workos-org-1",
    });
  });

  it.each([
    [{ name: "", slug: "uw", allowedDomains: ["uw.edu"] }],
    [{ name: "UW", slug: "Not Valid", allowedDomains: ["uw.edu"] }],
    [{ name: "UW", slug: "uw", allowedDomains: [] }],
    [{ name: "UW", slug: "uw", allowedDomains: ["not a domain"] }],
  ])("rejects invalid input", async (body) => {
    const response = await request(fakeAuthContext({ isSuperAdmin: true }), body);
    expect(response.status).toBe(400);
    expect(createOrganizationMock).not.toHaveBeenCalled();
  });

  it("returns conflict when another request already initialized the deployment", async () => {
    createOrganizationMock.mockResolvedValue({ created: false, organization: { id: "org-1" } });
    const response = await request(fakeAuthContext({ isSuperAdmin: true }), {
      name: "UW", slug: "uw", allowedDomains: ["uw.edu"],
    });
    expect(response.status).toBe(409);
  });
});
