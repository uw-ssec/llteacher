import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";
import type { Db } from "./client";

/**
 * Test-only DB client for Vitest integration tests that need a real
 * Postgres connection.
 *
 * Production code (`makeDb` in client.ts) uses @neondatabase/serverless's
 * HTTP driver -- the only driver that works inside a Cloudflare Worker (no
 * raw TCP sockets there). That driver speaks Neon's HTTP proxy protocol and
 * cannot reach a plain Postgres server, so it can't be pointed at the local
 * or CI pgvector container Vitest runs against. This client uses
 * node-postgres (`pg`, already a devDependency for the drizzle-kit CLI)
 * over a real TCP connection instead.
 *
 * The result is cast to `Db` at the boundary: both are drizzle-orm
 * PgDatabase instances over the same `schema`, differing only in a
 * query-result HKT type parameter TypeScript can't unify structurally.
 * Every repository function in this codebase uses only the schema-typed
 * query builder (select/insert/update/delete/query.*), never a raw
 * `.execute()` call whose shape depends on that parameter, so the runtime
 * behavior is identical -- this cast reflects verified compatibility, not
 * a hidden risk.
 */
export function makeTestDb(databaseUrl: string): Db {
  const pool = new Pool({ connectionString: databaseUrl });
  return drizzle(pool, { schema }) as unknown as Db;
}
