import { drizzle as drizzleNeon } from "drizzle-orm/neon-http";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";
import { logServerError } from "../server/utils/errors";

/** The Db type stays the neon-http shape every repository was written
 *  against; the runtime is node-postgres. Both are drizzle PgDatabase
 *  instances over the same schema. `db.batch` is absent at runtime, and
 *  every batch call site already feature-detects it (atomic.ts,
 *  finalizeAssistantTurn, updateHomework). See the "2026-09-16: the split
 *  is retired" section at the top of db-driver-split.md. */
export type Db = ReturnType<typeof drizzleNeon<typeof schema>>;

const pools = new Map<string, Pool>();

export function makeDb(databaseUrl: string): Db {
  let pool = pools.get(databaseUrl);
  if (!pool) {
    pool = new Pool({ connectionString: databaseUrl, max: 10 });
    // node-postgres emits `error` on the POOL (not on a query) when an
    // *idle* client dies -- Postgres restarting, an idle-timeout on a proxy,
    // a network blip. That error belongs to no request, so it reaches the
    // pool's own EventEmitter, and an EventEmitter with no "error" listener
    // rethrows: the whole process would exit on a dropped idle connection
    // the pool is perfectly able to replace on its own. Logging it is the
    // entire fix.
    pool.on("error", (err) => logServerError("db.pool", err));
    pools.set(databaseUrl, pool);
  }
  return drizzle(pool, { schema }) as unknown as Db;
}

/** Ends every pooled connection and forgets the pools, so a cached Pool
 *  cannot keep the event loop alive after a shutdown signal. Used by
 *  server/node.ts's SIGTERM/SIGINT handler; a later makeDb() simply builds a
 *  fresh pool. A pool that fails to end is logged rather than thrown: this
 *  only ever runs on the way out, and one bad pool must not stop the rest
 *  from closing. */
export async function closePools(): Promise<void> {
  const open = [...pools.values()];
  pools.clear();
  await Promise.all(
    open.map((pool) => pool.end().catch((err) => logServerError("db.pool.end", err))),
  );
}
