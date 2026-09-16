import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";
import type { Db } from "./client";

/**
 * The un-pooled sibling of `client.ts`'s `makeDb`. Same node-postgres
 * driver, same schema, same `as unknown as Db` cast -- the only difference
 * is that this constructs a fresh, uncached `Pool` on every call instead of
 * caching one per URL. That's fine for its two callers, which each run as a
 * short-lived plain Node process and only ever call it once: Vitest
 * integration tests and the `db:seed` script (`apps/web/scripts/seed.ts`).
 * It would leak connections if used the way `makeDb` is (repeatedly, across
 * requests in a long-lived process) -- see the "2026-09-16: the split is
 * retired" section at the top of db-driver-split.md for why two clients
 * still exist even though both now speak the same protocol.
 *
 * The result is cast to `Db` at the boundary: both are drizzle-orm
 * PgDatabase instances over the same `schema`, differing only in a
 * query-result HKT type parameter TypeScript can't unify structurally.
 * Every repository function in this codebase uses only the schema-typed
 * query builder (select/insert/update/delete/query.*), never a raw
 * `.execute()` call whose shape depends on that parameter, so the runtime
 * behavior is identical -- this cast reflects verified compatibility, not
 * a hidden risk. One exception: `db.batch` is a driver-capability method
 * that genuinely differs (present on neon-http, absent at runtime here) --
 * repositories/homeworks.ts's updateHomework feature-detects it via
 * `typeof db.batch === "function"` rather than calling it unconditionally,
 * so this cast's underlying claim still holds; the next `.batch()` call
 * site should do the same.
 */
export function makeNodeDb(databaseUrl: string): Db {
  const pool = new Pool({ connectionString: databaseUrl });
  return drizzle(pool, { schema }) as unknown as Db;
}
