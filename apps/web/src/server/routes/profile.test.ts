import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { getProfileHandler, patchProfileHandler } from "./profile";
import { auditEvents } from "../../db/schema";
import type { SessionPayload } from "../../lib/session";
import type { AppEnv } from "../context";

const TEST_ENV = {
  ENCRYPTION_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
  BLIND_INDEX_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
  DATABASE_URL: "ignored",
} as Env;

// #147: patchProfileHandler audits every successful update. auditInserts
// captures those writes (db.insert(auditEvents, ...), dispatched by table
// the same way auth.test.ts's mock does); dbOrgScopesForUser feeds
// getOrgScopesForUser's selectDistinct query.
let auditInserts: Record<string, unknown>[] = [];
let dbOrgScopesForUser: string[] = [];
let auditInsertError: Error | null = null;

vi.mock("../../db/client", () => ({
  makeDb: () => ({
    insert: (table: unknown) => {
      if (table === auditEvents) {
        return {
          values: (v: Record<string, unknown>) => {
            if (auditInsertError) throw auditInsertError;
            auditInserts.push(v);
            return { returning: async () => [{ id: "audit-1", ...v }] };
          },
        };
      }
      throw new Error("unexpected insert in profile.test.ts mock");
    },
    selectDistinct: () => ({
      from: () => ({
        innerJoin: () => ({
          where: async () => dbOrgScopesForUser.map((organizationId) => ({ organizationId })),
        }),
      }),
    }),
  }),
}));

beforeEach(() => {
  auditInserts = [];
  dbOrgScopesForUser = [];
  auditInsertError = null;
});

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

const SESSION: SessionPayload = { userId: "u1", workosUserId: "w1", sessionEpoch: 0, issuedAt: 0, expiresAt: 0 };

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

  it("audits profile.updated (#147) against every org the user belongs to", async () => {
    dbOrgScopesForUser = ["org-a", "org-b"];
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
    expect(auditInserts).toHaveLength(2);
    expect(auditInserts.map((a) => a.organizationId).sort()).toEqual(["org-a", "org-b"]);
    for (const insert of auditInserts) {
      expect(insert).toMatchObject({
        actorUserId: "u1",
        action: "profile.updated",
        targetType: "user",
        targetId: "u1",
      });
    }
  });

  it("still returns the updated profile even if the audit write fails", async () => {
    updateDisplayName.mockResolvedValue({ displayName: "New Name" });
    dbOrgScopesForUser = ["org-a"];
    auditInsertError = new Error("connection refused: ECONNREFUSED");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

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
    const body = (await res.json()) as { displayName: string };
    expect(body.displayName).toBe("New Name");
    expect(consoleSpy).toHaveBeenCalledWith(expect.anything(), auditInsertError);

    consoleSpy.mockRestore();
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

  it("returns 400 (not 503) for a malformed JSON body", async () => {
    updateDisplayName.mockReset();
    const res = await buildApp(SESSION).request(
      "/api/profile",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: "not json",
      },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect(updateDisplayName).not.toHaveBeenCalled();
  });
});
