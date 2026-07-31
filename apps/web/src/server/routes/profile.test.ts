import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { getProfileHandler, patchProfileHandler } from "./profile";
import type { SessionPayload } from "../../lib/session";
import type { AppEnv } from "../context";

const TEST_ENV = {
  ENCRYPTION_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
  BLIND_INDEX_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
  DATABASE_URL: "ignored",
} as Env;

vi.mock("../../db/client", () => ({ makeDb: () => ({}) }));

const getProfileWithStats = vi.fn();
const updateDisplayName = vi.fn();
vi.mock("../../lib/services/ProfileService", () => ({
  ProfileService: class {
    getProfileWithStats(userId: string) {
      return getProfileWithStats(userId);
    }
    updateDisplayName(userId: string, name: string) {
      return updateDisplayName(userId, name);
    }
  },
}));

function buildApp(session: SessionPayload | undefined) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  app.get("/api/profile", getProfileHandler);
  app.patch("/api/profile", patchProfileHandler);
  return app;
}

const SESSION: SessionPayload = { userId: "u1", workosUserId: "w1", issuedAt: 0, expiresAt: 0 };

describe("GET /api/profile", () => {
  it("returns 401 without a session", async () => {
    const res = await buildApp(undefined).request("/api/profile", {}, TEST_ENV);
    expect(res.status).toBe(401);
  });

  it("returns the decrypted profile with stats", async () => {
    getProfileWithStats.mockResolvedValue({
      userId: "u1",
      email: "cdcore@uw.edu",
      displayName: "Cordero",
      role: "instructor",
      courseCount: 1,
      instructorStats: { homeworksCreated: 2 },
    });
    const res = await buildApp(SESSION).request("/api/profile", {}, TEST_ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { email: string };
    expect(body.email).toBe("cdcore@uw.edu");
    expect(getProfileWithStats).toHaveBeenCalledWith("u1");
  });
});

describe("PATCH /api/profile", () => {
  it("returns 400 when displayName is missing", async () => {
    const res = await buildApp(SESSION).request(
      "/api/profile",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 (not a 500/503) when displayName is not a string", async () => {
    const res = await buildApp(SESSION).request(
      "/api/profile",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: 1 }),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
  });

  it("updates and returns the new display name", async () => {
    updateDisplayName.mockResolvedValue({ displayName: "New Name" });
    const res = await buildApp(SESSION).request(
      "/api/profile",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "New Name" }),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(200);
    expect(updateDisplayName).toHaveBeenCalledWith("u1", "New Name");
  });

  it("returns 401 without a session", async () => {
    const res = await buildApp(undefined).request(
      "/api/profile",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "x" }),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(401);
  });
});
