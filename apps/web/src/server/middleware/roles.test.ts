import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { rolesMiddleware, type AuthContext } from "./roles";
import type { SessionPayload } from "../../lib/session";
import type { AppEnv } from "../context";

const MEMBERSHIPS = [
  { id: "m1", userId: "u1", courseId: "course-a", role: "instructor" },
  { id: "m2", userId: "u1", courseId: "course-b", role: "student" },
];

let findManyCalls = 0;
vi.mock("../../db/client", () => ({
  makeDb: () => ({
    query: {
      courseMemberships: {
        findMany: async () => {
          findManyCalls++;
          return MEMBERSHIPS;
        },
      },
    },
  }),
}));

function buildApp() {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    const session: SessionPayload = { userId: "u1", workosUserId: "w1", issuedAt: 0, expiresAt: 0 };
    c.set("session", session);
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
  it("resolves memberships and exposes role-check helpers", async () => {
    findManyCalls = 0;
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

  it("queries memberships exactly once per request", async () => {
    findManyCalls = 0;
    await buildApp().request("/api/x", {}, { DATABASE_URL: "ignored" } as Env);
    expect(findManyCalls).toBe(1);
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
    findManyCalls = 0;
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      const session: SessionPayload = { userId: "u1", workosUserId: "w1", issuedAt: 0, expiresAt: 0 };
      c.set("session", session);
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
  });
});
