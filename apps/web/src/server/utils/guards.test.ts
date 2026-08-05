import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { requireRole, requireCourseMember, requireInstructorOf } from "./guards";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";

function fakeAuthContext(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    session: { userId: "u1", workosUserId: "w1", sessionEpoch: 0, issuedAt: 0, expiresAt: 0 },
    memberships: [],
    hasRole: () => false,
    isMemberOf: () => false,
    isInstructorOf: () => false,
    ...overrides,
  };
}

function buildApp(authContext: AuthContext | undefined) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    if (authContext) c.set("authContext", authContext);
    await next();
  });
  app.get(
    "/api/instructor-only/:courseId",
    requireInstructorOf()(async (c) => c.json({ ok: true })),
  );
  app.get(
    "/api/member-only/:courseId",
    requireCourseMember()(async (c) => c.json({ ok: true })),
  );
  app.get(
    "/api/role-only",
    requireRole(["instructor", "admin"])(async (c) => c.json({ ok: true })),
  );
  return app;
}

describe("requireInstructorOf", () => {
  it("allows an instructor of the course", async () => {
    const app = buildApp(fakeAuthContext({ isInstructorOf: (id) => id === "course-a" }));
    const res = await app.request("/api/instructor-only/course-a");
    expect(res.status).toBe(200);
  });

  it("denies a student", async () => {
    const app = buildApp(fakeAuthContext());
    const res = await app.request("/api/instructor-only/course-a");
    expect(res.status).toBe(403);
  });

  it("denies cross-course access", async () => {
    const app = buildApp(fakeAuthContext({ isInstructorOf: (id) => id === "course-b" }));
    const res = await app.request("/api/instructor-only/course-a");
    expect(res.status).toBe(403);
  });

  it("denies when there is no authContext at all", async () => {
    const app = buildApp(undefined);
    const res = await app.request("/api/instructor-only/course-a");
    expect(res.status).toBe(403);
  });
});

describe("requireCourseMember", () => {
  it("allows a member of the course", async () => {
    const app = buildApp(fakeAuthContext({ isMemberOf: (id) => id === "course-a" }));
    const res = await app.request("/api/member-only/course-a");
    expect(res.status).toBe(200);
  });

  it("denies a non-member", async () => {
    const app = buildApp(fakeAuthContext());
    const res = await app.request("/api/member-only/course-a");
    expect(res.status).toBe(403);
  });
});

describe("requireRole", () => {
  it("allows any of the listed roles", async () => {
    const app = buildApp(fakeAuthContext({ hasRole: (r) => r === "admin" }));
    const res = await app.request("/api/role-only");
    expect(res.status).toBe(200);
  });

  it("denies when none of the listed roles match", async () => {
    const app = buildApp(fakeAuthContext());
    const res = await app.request("/api/role-only");
    expect(res.status).toBe(403);
  });
});
