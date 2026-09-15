import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { closeDb } from "../db/client";
import { loadRuntimeConfig } from "../runtime/config";
import { app } from "../server";

export type NodeServerOptions = {
  adminBuildDir?: string;
  hostname?: string;
  port?: number;
  webBuildDir?: string;
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
export async function closeNodeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeDb();
}

export function startNodeServer(): Server {
  const server = createNodeServer(loadRuntimeConfig(process.env));
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    void closeNodeServer(server).then(
      () => process.exit(0),
      (error: unknown) => {
        console.error("Failed to shut down Node server", error);
        process.exit(1);
      },
    );
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startNodeServer();
}
