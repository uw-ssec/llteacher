import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";
import type { Db } from "./client";

/**
 * Dedicated database client for integration tests and one-off Node scripts
 * such as `apps/web/scripts/seed.ts`. The application runtime uses the
 * process-owned, closeable `makeDb` client instead.
 *
 * Both clients use node-postgres over the standard PostgreSQL wire protocol.
 * This helper remains separate because test suites and short-lived scripts
 * need an independently constructed handle rather than the application's
 * process singleton.
 *
 * The result is cast to `Db` at the boundary: both are drizzle-orm
 * PgDatabase instances over the same `schema`, differing only in a
 * query-result HKT type parameter TypeScript can't unify structurally.
 * Every repository function in this codebase uses only the schema-typed
 * query builder (select/insert/update/delete/query.*), never a raw
 * `.execute()` call whose shape depends on that parameter, so the runtime
 * behavior is identical -- this cast reflects verified compatibility, not
 * a hidden risk. The shared `Db` type retains a compatibility-only `batch`
 * member for repository code that feature-detects it; node-postgres does not
 * expose that method at runtime, so those code paths use transactions.
 */
export function makeNodeDb(databaseUrl: string): Db {
  const pool = new Pool({ connectionString: databaseUrl });
  return drizzle(pool, { schema }) as unknown as Db;
}
