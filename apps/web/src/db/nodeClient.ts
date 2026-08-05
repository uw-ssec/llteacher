import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";
import type { Db } from "./client";

/**
 * DB client for anything that runs as a plain Node process rather than
 * inside the Cloudflare Worker -- Vitest integration tests and the
 * `db:seed` script (`apps/web/scripts/seed.ts`).
 *
 * Production code (`makeDb` in client.ts) uses @neondatabase/serverless's
 * HTTP driver -- the only driver that works inside a Cloudflare Worker (no
 * raw TCP sockets there). That driver speaks Neon's HTTP proxy protocol and
 * cannot reach a plain Postgres server, so it can't be pointed at the local
 * or CI pgvector container. This client uses node-postgres (`pg`, already a
 * devDependency for the drizzle-kit CLI, which has the same constraint)
 * over a real TCP connection instead -- works against local/CI Postgres
 * *and* a real Neon database, since Neon also speaks plain Postgres wire
 * protocol over TCP+SSL, not just HTTP.
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
export function makeNodeDb(databaseUrl: string): Db {
  const pool = new Pool({ connectionString: databaseUrl });
  return drizzle(pool, { schema }) as unknown as Db;
}
