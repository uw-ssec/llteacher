import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { getSectionHintsHandler } from "./hints";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import type { HintCountResponse } from "../../shared/types";
import { fakeAuthContext, fakeMembership } from "../testing/authContext";

const TEST_ENV = { DATABASE_URL: "ignored" } as Env;

const getSectionHintStatusMock = vi.fn();
vi.mock("../repositories/hints", () => ({
  getSectionHintStatus: (...a: unknown[]) => getSectionHintStatusMock(...a),
}));
vi.mock("../../db/client", () => ({ makeDb: () => ({}) }));

function buildApp(authContext: AuthContext | undefined) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    if (authContext) c.set("authContext", authContext);
    await next();
  });
  app.get("/api/courses/:courseId/sections/:sectionId/hints", (c) => getSectionHintsHandler(c));
  return app;
}

describe("GET /api/courses/:courseId/sections/:sectionId/hints (#80)", () => {
  beforeEach(() => {
    getSectionHintStatusMock.mockReset();
  });

  it("denies a caller with no membership in the course", async () => {
    const res = await buildApp(fakeAuthContext({ memberships: [] })).request(
      "/api/courses/course-1/sections/sec-1/hints",
      undefined,
      TEST_ENV,
    );
    expect(res.status).toBe(403);
    expect(getSectionHintStatusMock).not.toHaveBeenCalled();
  });

  it("404s a malformed sectionId before it reaches the repository", async () => {
    const authContext = fakeAuthContext({
      memberships: [fakeMembership({ courseId: "course-1", role: "student", userId: "u1" })],
      session: { userId: "u1" } as AuthContext["session"],
    });
    const res = await buildApp(authContext).request(
      "/api/courses/course-1/sections/not-a-uuid/hints",
      undefined,
      TEST_ENV,
    );
    expect(res.status).toBe(404);
    expect(getSectionHintStatusMock).not.toHaveBeenCalled();
  });

  it("404s when the repository reports the section is outside this course scope", async () => {
    const authContext = fakeAuthContext({
      memberships: [fakeMembership({ courseId: "course-1", role: "student", userId: "u1" })],
      session: { userId: "u1" } as AuthContext["session"],
    });
    getSectionHintStatusMock.mockResolvedValue(null);
    const res = await buildApp(authContext).request(
      "/api/courses/course-1/sections/11111111-1111-1111-1111-111111111111/hints",
      undefined,
      TEST_ENV,
    );
    expect(res.status).toBe(404);
  });

  it("returns the caller's own count/limit/remaining", async () => {
    const authContext = fakeAuthContext({
      memberships: [fakeMembership({ courseId: "course-1", role: "student", userId: "u1" })],
      session: { userId: "u1" } as AuthContext["session"],
    });
    const status: HintCountResponse = { count: 2, limit: 3, remaining: 1 };
    getSectionHintStatusMock.mockResolvedValue(status);

    const res = await buildApp(authContext).request(
      "/api/courses/course-1/sections/11111111-1111-1111-1111-111111111111/hints",
      undefined,
      TEST_ENV,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(status);
    // The caller's OWN userId, not something taken from the request --
    // reading someone else's hint count is not this route's job.
    expect(getSectionHintStatusMock).toHaveBeenCalledWith(
      expect.anything(),
      "course-1",
      "11111111-1111-1111-1111-111111111111",
      "u1",
    );
  });
});
