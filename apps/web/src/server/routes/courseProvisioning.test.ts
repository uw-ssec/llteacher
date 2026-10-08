import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../context";
import { fakeAuthContext } from "../testing/authContext";
import { provisionCourseHandler } from "./courseProvisioning";

const provisionMock = vi.fn();
vi.mock("../repositories/courseProvisioning", () => ({ provisionInstructorCourse: (...a: unknown[]) => provisionMock(...a) }));
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
  beforeEach(() => provisionMock.mockReset().mockResolvedValue({
    status: "created", course: { id: "course-1", title: "Statistics", code: "STAT 311", term: "Autumn 2026" },
    instructor: { userId: "user-2", email: "prof@uw.edu" },
  }));

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
