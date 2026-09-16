import { drizzle as drizzleNeon } from "drizzle-orm/neon-http";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

/** The Db type stays the neon-http shape every repository was written
 *  against; the runtime is node-postgres. Both are drizzle PgDatabase
 *  instances over the same schema. `db.batch` is absent at runtime, and
 *  every batch call site already feature-detects it (atomic.ts,
 *  finalizeAssistantTurn, updateHomework). See db-driver-split.md. */
export type Db = ReturnType<typeof drizzleNeon<typeof schema>>;

const pools = new Map<string, Pool>();

export function makeDb(databaseUrl: string): Db {
  let pool = pools.get(databaseUrl);
  if (!pool) {
    pool = new Pool({ connectionString: databaseUrl, max: 10 });
    pools.set(databaseUrl, pool);
  }
  return drizzle(pool, { schema }) as unknown as Db;
}
