import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { access } from "node:fs/promises";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { SESSION_COOKIE_NAME, createSessionPayload, loadSessionKey, sealSession } from "../lib/session";
const { autoSubmitOverdueSections, closeDb, makeDb, recoverInterruptedExtractions, startOverdueScheduler, withSessionAdvisoryLock } = vi.hoisted(() => ({
  autoSubmitOverdueSections: vi.fn().mockResolvedValue(undefined),
  closeDb: vi.fn().mockResolvedValue(undefined),
  makeDb: vi.fn(() => ({ query: {} })),
  recoverInterruptedExtractions: vi.fn().mockResolvedValue(undefined),
  startOverdueScheduler: vi.fn((_options?: unknown) => ({ stop: vi.fn().mockResolvedValue(undefined) })),
  withSessionAdvisoryLock: vi.fn(async (_key: number, work: () => Promise<unknown>) => ({ acquired: true, value: await work() })),
}));
const { getAuthorizationUrl } = vi.hoisted(() => ({ getAuthorizationUrl: vi.fn(() => "https://workos.test/login") }));

vi.mock("../db/client", () => ({ closeDb, makeDb, withSessionAdvisoryLock }));
vi.mock("../server/jobs/autoSubmitOverdue", () => ({ autoSubmitOverdueSections }));
vi.mock("../server/repositories/materials", () => ({ recoverInterruptedExtractions }));
vi.mock("./overdue-scheduler", () => ({ startOverdueScheduler }));
vi.mock("../lib/workos", () => ({
  getWorkOS: () => ({ userManagement: { getAuthorizationUrl } }),
}));
vi.mock("../server/middleware/roles", () => ({ rolesMiddleware: async (_c: unknown, next: () => Promise<void>) => next() }));

import { closeNodeServer, createNodeServer, registerShutdownHandlers, startNodeServer } from "./server";

const runtimeConfig = {
  APP_URL: "https://llteacher.local",
  DATABASE_URL: "postgres://llteacher:password@localhost:5432/llteacher",
  WORKOS_API_KEY: "workos-api-key",
  WORKOS_CLIENT_ID: "workos-client-id",
  OPENROUTER_API_KEY: "openrouter-api-key",
  LLMOXIE_API_KEY: "llmoxie-api-key",
  SESSION_SECRET: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
  ENCRYPTION_KEY: "encryption-key",
  BLIND_INDEX_KEY: "blind-index-key",
  WORKOS_WEBHOOK_SECRET: "webhook-secret",
  STORAGE_ENDPOINT: "http://localhost:9000",
  STORAGE_BUCKET: "llteacher-materials",
  STORAGE_ACCESS_KEY_ID: "minioadmin",
  STORAGE_SECRET_ACCESS_KEY: "minioadmin",
  KNOWLEDGE_ROOT: "/tmp",
} satisfies Env;

let buildRoot: string;
let server: Server | undefined;

beforeEach(async () => {
  closeDb.mockClear();
  makeDb.mockClear();
  withSessionAdvisoryLock.mockClear();
  autoSubmitOverdueSections.mockClear();
  recoverInterruptedExtractions.mockClear();
  recoverInterruptedExtractions.mockResolvedValue(undefined);
  startOverdueScheduler.mockClear();
  startOverdueScheduler.mockReturnValue({ stop: vi.fn().mockResolvedValue(undefined) });
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
    expect(await response.json()).toMatchObject({ status: "ok" });
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

  it("uses the configured public origin and ignores hostile forwarding headers", async () => {
    const response = await request("/api/auth/login", {
      headers: {
        "x-forwarded-host": "attacker.example",
        "x-forwarded-proto": "http",
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

  it("stops and awaits background work before draining extractions and closing the database", async () => {
    const events: string[] = [];
    const background = { stop: vi.fn(async () => { events.push("scheduler stopped"); }) };
    server = createNodeServer(runtimeConfig, {
      adminBuildDir: join(buildRoot, "admin"), port: 0, webBuildDir: join(buildRoot, "web"),
    });
    await new Promise<void>((resolve) => server!.once("listening", resolve));

    await closeNodeServer(server, 25_000, async () => {
      await background.stop();
      events.push(`database closed: ${closeDb.mock.calls.length}`);
    });
    server = undefined;

    expect(events).toEqual(["scheduler stopped", "database closed: 0"]);
    expect(closeDb).toHaveBeenCalledOnce();
  });

  it("bounds the entire shutdown even when background work never stops", async () => {
    let release!: () => void;
    const background = new Promise<void>((resolve) => { release = resolve; });
    const closingServer = {
      close: (done: () => void) => done(),
      closeAllConnections: vi.fn(),
    } as unknown as Server;

    await expect(closeNodeServer(closingServer, 20, () => background))
      .rejects.toThrow("Shutdown deadline exceeded");
    expect(closingServer.closeAllConnections).toHaveBeenCalledOnce();
    expect(closeDb).not.toHaveBeenCalled();
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closeDb).not.toHaveBeenCalled();
  }, 1_000);

  it("initializes storage and starts the locked overdue scheduler", async () => {
    const knowledgeRoot = join(buildRoot, "nested", "knowledge");
    const started = startNodeServer({
      adminBuildDir: join(buildRoot, "admin"),
      config: { ...runtimeConfig, KNOWLEDGE_ROOT: knowledgeRoot },
      port: 0,
      webBuildDir: join(buildRoot, "web"),
    });
    server = started;
    await new Promise<void>((resolve) => server!.once("listening", resolve));

    await expect(access(knowledgeRoot)).resolves.toBeUndefined();
    expect(makeDb).toHaveBeenCalledWith(runtimeConfig.DATABASE_URL);
    expect(recoverInterruptedExtractions).toHaveBeenCalledOnce();
    expect(startOverdueScheduler).toHaveBeenCalledOnce();
    const schedulerOptions = startOverdueScheduler.mock.calls[0]![0] as { run(): Promise<unknown> };
    await schedulerOptions.run();
    expect(withSessionAdvisoryLock).toHaveBeenCalledWith(0x4c4c5453, expect.any(Function));
    expect(autoSubmitOverdueSections).toHaveBeenCalledOnce();
  });

  it("force-closes connections when graceful shutdown exceeds its deadline", async () => {
    vi.useFakeTimers();
    const forceClose = vi.fn();
    const stalledServer = {
      close: vi.fn(),
      closeAllConnections: forceClose,
    } as unknown as Server;

    const shutdown = closeNodeServer(stalledServer, 25_000);
    const rejected = expect(shutdown).rejects.toThrow("Shutdown deadline exceeded");
    await vi.advanceTimersByTimeAsync(25_000);
    await rejected;

    expect(forceClose).toHaveBeenCalledOnce();
    expect(closeDb).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it.each(["SIGINT", "SIGTERM"] as const)("runs bounded shutdown once for %s", async (signal) => {
    const handlers = new Map<string, () => void>();
    const close = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn();
    registerShutdownHandlers({} as Server, {
      close,
      once: (name, handler) => { handlers.set(name, handler); },
      exit,
      error: vi.fn(),
    });

    handlers.get(signal)?.();
    handlers.get(signal)?.();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(close).toHaveBeenCalledOnce();
  });
});
