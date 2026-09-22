import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { Server } from "node:http";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { closeDb, makeDb, withSessionAdvisoryLock } from "../db/client";
import { drainExtractions } from "../server/knowledge/extract/job";
import { recoverInterruptedExtractions } from "../server/repositories/materials";
import { loadRuntimeConfig } from "../runtime/config";
import { app } from "../server";
import { autoSubmitOverdueSections } from "../server/jobs/autoSubmitOverdue";
import { startOverdueScheduler } from "./overdue-scheduler";

export type NodeServerOptions = {
  adminBuildDir?: string;
  hostname?: string;
  port?: number;
  webBuildDir?: string;
};

export type StartNodeServerOptions = NodeServerOptions & {
  config?: Env;
};

const defaultWebBuildDir = resolve(import.meta.dirname, "../../dist/client");
const defaultAdminBuildDir = resolve(import.meta.dirname, "../../../admin/dist/admin");
// ASCII "LLTS": stable database-wide lock for LLTeacher's overdue sweep.
const OVERDUE_SWEEP_LOCK_KEY = 0x4c4c5453;

function createNodeApp(config: Env, options: NodeServerOptions) {
  const nodeApp = new Hono();
  const webBuildDir = options.webBuildDir ?? defaultWebBuildDir;
  const adminBuildDir = options.adminBuildDir ?? defaultAdminBuildDir;
  const api = (c: { req: { raw: Request } }) => app.fetch(c.req.raw, config);

  nodeApp.use("*", async (c, next) => {
    await next();
    c.res.headers.set("Cross-Origin-Opener-Policy", "same-origin");
    c.res.headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  });

  // Keep API responses (including the API app's JSON 404) ahead of either
  // SPA fallback. A missing API route must never look like a successful page.
  nodeApp.all("/api", api);
  nodeApp.all("/api/*", api);

  nodeApp.get("/admin", serveStatic({ root: adminBuildDir, path: "index.html" }));
  nodeApp.get(
    "/admin/*",
    serveStatic({
      root: adminBuildDir,
      rewriteRequestPath: (requestPath) => requestPath.replace(/^\/admin\/?/, ""),
    }),
  );
  nodeApp.get("/admin/*", serveStatic({ root: adminBuildDir, path: "index.html" }));

  nodeApp.get("*", serveStatic({ root: webBuildDir }));
  nodeApp.get("*", serveStatic({ root: webBuildDir, path: "index.html" }));

  return nodeApp;
}

/**
 * Starts the Hono Node adapter. Optional build directories and port make the
 * factory testable while production uses PORT and the container build paths.
 */
export function createNodeServer(config: Env, options: NodeServerOptions = {}): Server {
  const port = options.port ?? Number(process.env.PORT ?? 3000);
  return serve({
    fetch: createNodeApp(config, options).fetch,
    hostname: options.hostname,
    port,
  }) as Server;
}

/** Stops accepting requests before releasing the process-owned database pool. */
export async function closeNodeServer(
  server: Server,
  timeoutMs = 25_000,
  stopBackgroundWork: () => Promise<void> = async () => {},
): Promise<void> {
  // One budget for HTTP, background work, extraction drain, and pool closure;
  // ECS's default 30-second stop window must not be spent again at every stage.
  let timer!: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      server.closeAllConnections();
      reject(new Error("Shutdown deadline exceeded"));
    }, timeoutMs);
    timer.unref();
  });
  try {
    await Promise.race([deadline, new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })]);
    await Promise.race([deadline, stopBackgroundWork()]);
    // #40: interrupted extractions are recovered at next start. On deadline
    // failure, the signal handler exits; do not close the pool underneath work
    // that is still running or continue cleanup after a timed-out stage settles.
    await Promise.race([deadline, drainExtractions(EXTRACTION_DRAIN_MS)]);
    await Promise.race([deadline, closeDb()]);
  } finally {
    clearTimeout(timer);
  }
}

const EXTRACTION_DRAIN_MS = 20_000;

export type ShutdownDependencies = {
  close(server: Server): Promise<void>;
  once(signal: "SIGINT" | "SIGTERM", handler: () => void): void;
  exit(code: number): void;
  error(message: string, error: unknown): void;
};

export function registerShutdownHandlers(server: Server, dependencies: ShutdownDependencies = {
  close: closeNodeServer,
  once: (signal, handler) => process.once(signal, handler),
  exit: (code) => process.exit(code),
  error: (message, error) => console.error(message, error),
}): void {
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    void dependencies.close(server).then(
      () => dependencies.exit(0),
      (error: unknown) => {
        dependencies.error("Failed to shut down Node server", error);
        dependencies.exit(1);
      },
    );
  };

  dependencies.once("SIGINT", shutdown);
  dependencies.once("SIGTERM", shutdown);
}

export function startNodeServer(options: StartNodeServerOptions = {}): Server {
  const config = options.config ?? loadRuntimeConfig(process.env);
  if (config.KNOWLEDGE_ROOT) mkdirSync(config.KNOWLEDGE_ROOT, { recursive: true });
  const db = makeDb(config.DATABASE_URL);
  // Materials left at `processing` by a task that died mid-extraction are
  // moved to `failed` with a reason, so the console never shows a spinner
  // for work nothing is doing. Best effort; a failure here must not stop
  // the server from serving.
  void recoverInterruptedExtractions(db).catch((error: unknown) => {
    console.error("Failed to recover interrupted extractions", error);
  });
  const scheduler = startOverdueScheduler({
    run: async () => {
      await withSessionAdvisoryLock(OVERDUE_SWEEP_LOCK_KEY, () => autoSubmitOverdueSections(db));
    },
    error: (message) => console.error(message),
  });
  const server = createNodeServer(config, options);
  registerShutdownHandlers(server, {
    close: (serverToClose) => closeNodeServer(serverToClose, 25_000, () => scheduler.stop()),
    once: (signal, handler) => process.once(signal, handler),
    exit: (code) => process.exit(code),
    error: (message, error) => console.error(message, error),
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startNodeServer();
}
