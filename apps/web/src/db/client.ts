import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

type NodeDb = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Repository code feature-detects `batch` so it can share query builders
 * with the former HTTP driver. node-postgres does not provide it at runtime,
 * but retaining its structural type keeps those guarded branches type-safe
 * until the migration removes the Worker-only path.
 */
export type Db = NodeDb & {
  batch(queries: readonly unknown[]): Promise<any[]>;
};

export function makeDb(databaseUrl: string): Db {
  const pool = new Pool({ connectionString: databaseUrl, max: 10 });
  return drizzle(pool, { schema }) as Db;
}
