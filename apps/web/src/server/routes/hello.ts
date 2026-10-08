import { Hono } from "hono";
import { Effect } from "effect";
import { createPing } from "../repositories/pings";
import type { HelloResponse } from "../../shared/types";
import type { AppEnv } from "../context";
import { effectHandler } from "../effect/http";
import { query } from "../effect/services";

export const helloHandler = effectHandler((c) => Effect.gen(function* () {
  // Dev fallback: when no DATABASE_URL is configured, return a stub so the
  // React app renders end-to-end without provisioning Neon. The real Drizzle
  // path takes over the moment DATABASE_URL is set in web/.dev.vars.
  if (!c.env.DATABASE_URL) {
    const resp: HelloResponse = {
      message: "Hono Worker is alive. (stub — set DATABASE_URL to hit Neon)",
      ping_id: crypto.randomUUID(),
    };
    return c.json(resp);
  }

  const row = yield* query("createPing", (db) => createPing(db, "Hello from Hono + Drizzle + Neon."));
  const resp: HelloResponse = {
    message: row.message,
    ping_id: row.id,
  };
  return c.json(resp);
}));

// Sub-app preserved for direct unit testing; production routing happens via
// app.get("/api/hello", helloHandler) in server/index.ts.
export const hello = new Hono<AppEnv>();
hello.get("/", helloHandler);
