import { Hono, type Context } from "hono";
import { makeDb } from "../../db/client";
import { createPing } from "../repositories/pings";
import type { HelloResponse } from "../../shared/types";

export async function helloHandler(c: Context<{ Bindings: Env }>) {
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

  const db = makeDb(c.env.DATABASE_URL);
  const row = await createPing(db, "Hello from Hono + Drizzle + Neon.");
  const resp: HelloResponse = {
    message: row.message,
    ping_id: row.id,
  };
  return c.json(resp);
}

// Sub-app preserved for direct unit testing; production routing happens via
// app.get("/api/hello", helloHandler) in server/index.ts.
export const hello = new Hono<{ Bindings: Env }>();
hello.get("/", helloHandler);
