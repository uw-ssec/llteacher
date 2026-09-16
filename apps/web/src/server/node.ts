import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import path from "node:path";
import { app } from "./index";
import { makeDb } from "../db/client";
import { autoSubmitOverdueSections } from "./jobs/autoSubmitOverdue";
import { logServerError } from "./utils/errors";

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

export function buildNodeApp(env: Env) {
  const outer = new Hono();
  outer.all("/api/*", (c) => app.fetch(c.req.raw, env));
  outer.use("*", serveStatic({ root: path.relative(process.cwd(), CLIENT_DIR) }));
  outer.get("*", (c) => c.html(readFileSync(path.join(CLIENT_DIR, "index.html"), "utf8")));
  return outer;
}

if (process.argv[1]?.endsWith("node.ts") || process.argv[1]?.endsWith("node.js")) {
  const env = envFromProcess();
  const port = Number(process.env.PORT ?? 8080);
  serve({ fetch: buildNodeApp(env).fetch, port }, () => {
    console.log(JSON.stringify({ level: "info", msg: "listening", port }));
  });
  setInterval(() => {
    autoSubmitOverdueSections(makeDb(env.DATABASE_URL)).catch((err) =>
      logServerError("scheduled", err, { cron: "autoSubmitOverdue" }),
    );
  }, HOURLY_MS).unref();
}
