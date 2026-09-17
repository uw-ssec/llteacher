import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import path from "node:path";
import { app } from "./index";
import { closePools, makeDb } from "../db/client";
import { autoSubmitOverdueSections } from "./jobs/autoSubmitOverdue";
import { recoverInterruptedExtractions } from "./repositories/materials";
import { drainExtractions } from "./knowledge/extract/job";
import { logServerError, logServerInfo } from "./utils/errors";

const REQUIRED = [
  "DATABASE_URL", "WORKOS_API_KEY", "WORKOS_CLIENT_ID", "OPENROUTER_API_KEY",
  "LLMOXIE_API_KEY", "SESSION_SECRET", "ENCRYPTION_KEY", "BLIND_INDEX_KEY",
  "WORKOS_WEBHOOK_SECRET", "STORAGE_ENDPOINT", "STORAGE_BUCKET",
  "STORAGE_ACCESS_KEY_ID", "STORAGE_SECRET_ACCESS_KEY", "KNOWLEDGE_ROOT",
] as const;

export function envFromProcess(source: NodeJS.ProcessEnv = process.env): Env {
  const missing = REQUIRED.filter((k) => !source[k]);
  if (missing.length > 0) throw new Error(`Missing env: ${missing.join(", ")}`);
  const env = Object.fromEntries(REQUIRED.map((k) => [k, source[k]])) as unknown as Env;
  env.LLMOXIE_BASE_URL = source.LLMOXIE_BASE_URL;
  env.OKF_BINARY = source.OKF_BINARY;
  // The Worker served the SPA through this binding; on Node the outer app
  // below serves dist/client, so a request reaching this stub missed
  // every route and every file.
  env.ASSETS = { fetch: async () => new Response("Not found", { status: 404 }) } as unknown as Fetcher;
  return env;
}

const CLIENT_DIR = path.resolve(process.cwd(), "dist/client");
const HOURLY_MS = 60 * 60 * 1000;

export function buildNodeApp(env: Env, clientDir = CLIENT_DIR) {
  const outer = new Hono();
  // Static HTML bypasses the inner API app, but needs these page-level
  // headers too for WebR's SharedArrayBuffer execution channel.
  outer.use("*", async (c, next) => {
    await next();
    c.header("Cross-Origin-Opener-Policy", "same-origin");
    c.header("Cross-Origin-Embedder-Policy", "require-corp");
  });
  outer.all("/api/*", (c) => app.fetch(c.req.raw, env));
  outer.use("*", serveStatic({ root: path.relative(process.cwd(), clientDir) }));
  outer.get("*", (c) => c.html(readFileSync(path.join(clientDir, "index.html"), "utf8")));
  return outer;
}

/** I-4 (final review): how long a shutdown will wait for extractions that
 *  are already running. ECS sends SIGKILL 30 s after SIGTERM by default, so
 *  this leaves headroom for closePools() and process exit inside that
 *  window. An extraction still running at the deadline is abandoned, which
 *  leaves a processing row that startup recovery marks failed for Retry. */
const EXTRACTION_DRAIN_MS = 20_000;

/** Stops accepting connections, lets in-flight extractions finish (up to the
 *  drain deadline), closes the DB pools, and exits 0. A second signal
 *  short-circuits all of it -- an operator pressing Ctrl-C twice means
 *  "now", not "explain yourself". */
export function installShutdownHandlers(server: { close: () => void }): void {
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      logServerInfo("shutdown", "second signal, exiting immediately", { signal });
      // `return`, not a bare call: process.exit is typed `never` and does not
      // return in production, but saying so here is what keeps the guard a
      // guard rather than something that only works because the call below
      // never comes back.
      return process.exit(0);
    }
    shuttingDown = true;
    logServerInfo("shutdown", "draining", { signal, drainMs: EXTRACTION_DRAIN_MS });
    server.close();
    void (async () => {
      await drainExtractions(EXTRACTION_DRAIN_MS);
      await closePools();
      logServerInfo("shutdown", "drained, exiting");
      process.exit(0);
    })();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

export async function startNodeServer(env: Env, port: number) {
  // Recovery must finish before any request can enqueue new work. This is
  // valid for the supported single-process deployment, not overlapping replicas.
  await recoverInterruptedExtractions(makeDb(env.DATABASE_URL));
  return serve({ fetch: buildNodeApp(env).fetch, port }, () => {
    console.log(JSON.stringify({ level: "info", msg: "listening", port }));
  });
}

if (process.argv[1]?.endsWith("node.ts") || process.argv[1]?.endsWith("node.js")) {
  const env = envFromProcess();
  const server = await startNodeServer(env, Number(process.env.PORT ?? 8080));
  installShutdownHandlers(server);
  setInterval(() => {
    autoSubmitOverdueSections(makeDb(env.DATABASE_URL)).catch((err) =>
      logServerError("scheduled", err, { cron: "autoSubmitOverdue" }),
    );
  }, HOURLY_MS).unref();
}
