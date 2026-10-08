import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { grantPlatformInstructorHandler } from "./platformInstructors";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import { fakeAuthContext } from "../testing/authContext";
import { SERVICE_UNAVAILABLE_MESSAGE } from "../utils/errors";

const TEST_ENV = { DATABASE_URL: "ignored" } as Env;

const grantPlatformInstructorMock = vi.fn();
vi.mock("../repositories/users", () => ({
  grantPlatformInstructor: (...a: unknown[]) => grantPlatformInstructorMock(...a),
}));
vi.mock("../../db/client", () => ({ makeDb: () => ({}) }));
vi.mock("../../lib/secrets-loader", () => ({ loadIdentityCipherKeys: async () => ({}) }));
vi.mock("../../lib/crypto/identity-cipher", () => ({ IdentityCipher: class {} }));

function buildApp(authContext: AuthContext | undefined) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    if (authContext) c.set("authContext", authContext);
    await next();
  });
  app.post("/api/platform/instructors", (c) => grantPlatformInstructorHandler(c));
  return app;
}

const superAdmin = () => fakeAuthContext({ isSuperAdmin: true });
const instructor = () => fakeAuthContext({});

function post(authContext: AuthContext | undefined, body: unknown) {
  return buildApp(authContext).request(
    "/api/platform/instructors",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    TEST_ENV,
  );
}

beforeEach(() => {
  grantPlatformInstructorMock.mockReset().mockResolvedValue({
    status: "granted",
    userId: "u-new",
    grantedAt: new Date("2026-01-01T00:00:00Z"),
  });
});

describe("POST /api/platform/instructors (#316)", () => {
  it("grants a super admin's request", async () => {
    const res = await post(superAdmin(), { email: "new-instructor@uw.edu" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "granted",
      userId: "u-new",
      grantedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(grantPlatformInstructorMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "u1",
      "new-instructor@uw.edu",
    );
  });

  it("denies a non-super-admin, including a real course instructor", async () => {
    const res = await post(instructor(), { email: "x@uw.edu" });
    expect(res.status).toBe(403);
    expect(grantPlatformInstructorMock).not.toHaveBeenCalled();
  });

  it("denies when there is no authContext at all", async () => {
    const res = await post(undefined, { email: "x@uw.edu" });
    expect(res.status).toBe(403);
    expect(grantPlatformInstructorMock).not.toHaveBeenCalled();
  });

  it("400s malformed JSON", async () => {
    const res = await buildApp(superAdmin()).request(
      "/api/platform/instructors",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect(grantPlatformInstructorMock).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "   ", 42, null])("400s a missing/blank email (%j)", async (email) => {
    const res = await post(superAdmin(), { email });
    expect(res.status).toBe(400);
    expect(grantPlatformInstructorMock).not.toHaveBeenCalled();
  });

  it("maps a disallowed-domain result to 400", async () => {
    grantPlatformInstructorMock.mockResolvedValue({
      status: "disallowed_domain",
      message: 'Domain "gmail.com" is not allowed. Allowed domains: uw.edu',
    });
    const res = await post(superAdmin(), { email: "outsider@gmail.com" });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: expect.stringMatching(/gmail\.com/) });
  });

  it("maps an invalid-email result to 400", async () => {
    grantPlatformInstructorMock.mockResolvedValue({
      status: "invalid_email",
      message: "Invalid email format",
    });
    const res = await post(superAdmin(), { email: "not-an-email" });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/platform/instructors failure paths (Effect migration)", () => {
  it("answers a database failure with the generic 503", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    grantPlatformInstructorMock.mockRejectedValue(new Error("connection terminated"));
    const res = await post(superAdmin(), { email: "new@uw.edu" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: SERVICE_UNAVAILABLE_MESSAGE });
  });
});
