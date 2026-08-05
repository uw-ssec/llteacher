import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { rolesMiddleware, type AuthContext } from "./roles";
import type { SessionPayload } from "../../lib/session";
import type { AppEnv } from "../context";

const MEMBERSHIPS = [
  { id: "m1", userId: "u1", courseId: "course-a", role: "instructor" },
  { id: "m2", userId: "u1", courseId: "course-b", role: "student" },
];

let findManyCalls = 0;
let findFirstCalls = 0;
let userRow: { isActive: boolean; sessionEpoch: number } | undefined = {
  isActive: true,
  sessionEpoch: 0,
};
vi.mock("../../db/client", () => ({
  makeDb: () => ({
    query: {
      courseMemberships: {
        findMany: async () => {
          findManyCalls++;
          return MEMBERSHIPS;
        },
      },
      users: {
        findFirst: async () => {
          findFirstCalls++;
          return userRow;
        },
      },
    },
  }),
}));

function sessionFor(sessionEpoch: number): SessionPayload {
  return { userId: "u1", workosUserId: "w1", sessionEpoch, issuedAt: 0, expiresAt: 0 };
}

function buildApp(sessionEpoch = 0) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("session", sessionFor(sessionEpoch));
    await next();
  });
  app.use("*", rolesMiddleware);
  app.get("/api/x", (c) => {
    const authContext = c.get("authContext") as AuthContext;
    return c.json({
      hasInstructor: authContext.hasRole("instructor"),
      isInstructorOfA: authContext.isInstructorOf("course-a"),
      isInstructorOfB: authContext.isInstructorOf("course-b"),
      isMemberOfB: authContext.isMemberOf("course-b"),
      isMemberOfC: authContext.isMemberOf("course-c"),
    });
  });
  return app;
}

describe("rolesMiddleware", () => {
  beforeEach(() => {
    findManyCalls = 0;
    findFirstCalls = 0;
    userRow = { isActive: true, sessionEpoch: 0 };
  });

  it("resolves memberships and exposes role-check helpers", async () => {
    const res = await buildApp().request("/api/x", {}, { DATABASE_URL: "ignored" } as Env);
    const body = await res.json();
    expect(body).toEqual({
      hasInstructor: true,
      isInstructorOfA: true,
      isInstructorOfB: false,
      isMemberOfB: true,
      isMemberOfC: false,
    });
  });

  it("queries memberships and the user row exactly once per request", async () => {
    await buildApp().request("/api/x", {}, { DATABASE_URL: "ignored" } as Env);
    expect(findManyCalls).toBe(1);
    expect(findFirstCalls).toBe(1);
  });

  it("no-ops when there is no session", async () => {
    const app = new Hono<AppEnv>();
    app.use("*", rolesMiddleware);
    app.get("/api/x", (c) => c.json({ authContext: c.get("authContext") ?? null }));
    const res = await app.request("/api/x", {}, { DATABASE_URL: "ignored" } as Env);
    const body = (await res.json()) as { authContext: unknown };
    expect(body.authContext).toBeNull();
  });

  it("skips the membership query on PUBLIC_API_PATHS (e.g. logout) even with a session present", async () => {
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("session", sessionFor(0));
      await next();
    });
    app.use("*", rolesMiddleware);
    app.post("/api/auth/logout", (c) => c.json({ authContext: c.get("authContext") ?? null }));

    const res = await app.request(
      "/api/auth/logout",
      { method: "POST" },
      { DATABASE_URL: "ignored" } as Env,
    );
    const body = (await res.json()) as { authContext: unknown };

    expect(body.authContext).toBeNull();
    expect(findManyCalls).toBe(0);
    expect(findFirstCalls).toBe(0);
  });

  // #95: a WorkOS deprovisioning webhook flips is_active to false and bumps
  // session_epoch. Both need their own test -- either condition alone must
  // revoke an otherwise-cryptographically-valid cookie.
  it("returns 401 when the user row is deactivated (is_active = false)", async () => {
    userRow = { isActive: false, sessionEpoch: 0 };
    const res = await buildApp(0).request("/api/x", {}, { DATABASE_URL: "ignored" } as Env);
    expect(res.status).toBe(401);
  });

  it("returns 401 when the cookie's sessionEpoch is behind the user row's current epoch", async () => {
    userRow = { isActive: true, sessionEpoch: 3 };
    const res = await buildApp(2).request("/api/x", {}, { DATABASE_URL: "ignored" } as Env);
    expect(res.status).toBe(401);
  });

  it("returns 401 when the user row no longer exists", async () => {
    userRow = undefined;
    const res = await buildApp(0).request("/api/x", {}, { DATABASE_URL: "ignored" } as Env);
    expect(res.status).toBe(401);
  });

  it("allows the request through when sessionEpoch matches and the account is active", async () => {
    userRow = { isActive: true, sessionEpoch: 5 };
    const res = await buildApp(5).request("/api/x", {}, { DATABASE_URL: "ignored" } as Env);
    expect(res.status).toBe(200);
  });
});
