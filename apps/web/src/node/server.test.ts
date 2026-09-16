import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { SESSION_COOKIE_NAME, createSessionPayload, loadSessionKey, sealSession } from "../lib/session";
const { closeDb } = vi.hoisted(() => ({ closeDb: vi.fn().mockResolvedValue(undefined) }));
const { getAuthorizationUrl } = vi.hoisted(() => ({ getAuthorizationUrl: vi.fn(() => "https://workos.test/login") }));

vi.mock("../db/client", () => ({ closeDb, makeDb: vi.fn() }));
vi.mock("../lib/workos", () => ({
  getWorkOS: () => ({ userManagement: { getAuthorizationUrl } }),
}));
vi.mock("../server/middleware/roles", () => ({ rolesMiddleware: async (_c: unknown, next: () => Promise<void>) => next() }));

import { closeNodeServer, createNodeServer } from "./server";

const runtimeConfig = {
  DATABASE_URL: "postgres://llteacher:password@localhost:5432/llteacher",
  WORKOS_API_KEY: "workos-api-key",
  WORKOS_CLIENT_ID: "workos-client-id",
  OPENROUTER_API_KEY: "openrouter-api-key",
  LLMOXIE_API_KEY: "llmoxie-api-key",
  SESSION_SECRET: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
  ENCRYPTION_KEY: "encryption-key",
  BLIND_INDEX_KEY: "blind-index-key",
  WORKOS_WEBHOOK_SECRET: "webhook-secret",
} satisfies Env;

let buildRoot: string;
let server: Server | undefined;

beforeEach(async () => {
  closeDb.mockClear();
  buildRoot = await mkdtemp(join(tmpdir(), "llteacher-node-server-"));
  await mkdir(join(buildRoot, "web"));
  await mkdir(join(buildRoot, "admin"));
  await mkdir(join(buildRoot, "admin", "assets"));
  await writeFile(join(buildRoot, "web", "index.html"), "<h1>Student SPA</h1>");
  await writeFile(join(buildRoot, "admin", "index.html"), "<h1>Admin SPA</h1>");
  await writeFile(join(buildRoot, "admin", "assets", "admin.js"), "admin bundle");
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    if (!server) return resolve();
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await rm(buildRoot, { force: true, recursive: true });
  server = undefined;
});

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  server = createNodeServer(runtimeConfig, {
    adminBuildDir: join(buildRoot, "admin"),
    port: 0,
    webBuildDir: join(buildRoot, "web"),
  });
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Node server did not bind a TCP port");
  return fetch(`http://127.0.0.1:${address.port}${path}`, {
    ...init,
    headers: { ...init.headers, connection: "close" },
    redirect: "manual",
  });
}

describe("createNodeServer", () => {
  it("serves the student SPA at the root", async () => {
    const response = await request("/");

    expect(response.status).toBe(200);
    expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(response.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
    expect(await response.text()).toContain("Student SPA");
  });

  it("falls back to the student SPA for client-side routes", async () => {
    const response = await request("/any/client/route");

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Student SPA");
  });

  it("serves the admin SPA at /admin", async () => {
    const response = await request("/admin");

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Admin SPA");
  });

  it("falls back to the admin SPA for client-side admin routes", async () => {
    const response = await request("/admin/any/client/route");

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Admin SPA");
  });

  it("serves admin static assets below /admin", async () => {
    const response = await request("/admin/assets/admin.js");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("admin bundle");
  });

  it("keeps API requests in the Hono API app", async () => {
    const response = await request("/api/hello");

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("exposes an unauthenticated health endpoint for the load balancer", async () => {
    const response = await request("/api/health");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("returns the API app's JSON 404 for unknown API paths", async () => {
    const key = await loadSessionKey(runtimeConfig);
    const sealed = await sealSession(createSessionPayload("user-1", "workos-user-1", 0), key);
    const response = await request("/api/does-not-exist", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${sealed}` },
    });

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ error: "Not found" });
  });

  it("uses the HTTPS public origin forwarded by the ALB for API requests", async () => {
    const response = await request("/api/auth/login", {
      headers: {
        "x-forwarded-host": "llteacher.local",
        "x-forwarded-proto": "https",
      },
    });

    expect(response.status).toBe(302);
    expect(getAuthorizationUrl).toHaveBeenCalledWith(expect.objectContaining({
      redirectUri: "https://llteacher.local/api/auth/callback",
    }));
  });

  it("closes the database pool when the Node server shuts down", async () => {
    server = createNodeServer(runtimeConfig, {
      adminBuildDir: join(buildRoot, "admin"),
      port: 0,
      webBuildDir: join(buildRoot, "web"),
    });
    await new Promise<void>((resolve) => server!.once("listening", resolve));

    await closeNodeServer(server);
    server = undefined;

    expect(closeDb).toHaveBeenCalledOnce();
  });
});
