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
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => {
      server.closeAllConnections();
      finish();
    }, timeoutMs);
    timer.unref();
    server.close((error) => finish(error ?? undefined));
  });
  await stopBackgroundWork();
  // #40: an extraction in flight (a PDF being OCR'd) gets up to this long to
  // finish before the pool closes under it; whatever is still running is
  // marked interrupted on the next start (see startNodeServer).
  await drainExtractions(EXTRACTION_DRAIN_MS);
  await closeDb();
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
      await withSessionAdvisoryLock(0x4c4c5453, () => autoSubmitOverdueSections(db));
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
