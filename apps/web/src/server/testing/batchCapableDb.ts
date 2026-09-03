import { Pool, type PoolClient } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../db/schema";
import type { Db } from "../../db/client";

/**
 * #309: every repository test that touches a real Postgres database gets its
 * `Db` handle from `makeNodeDb` (node-postgres) -- which has no runtime
 * `db.batch()`, so the `typeof db.batch === "function"` branch every
 * atomicity-sensitive repository function carries for the production
 * neon-http driver (appendMessage, finalizeAssistantTurn, ...) has never
 * actually executed in any test. Only its `db.transaction()` fallback
 * sibling has.
 *
 * This builds a second `Db` handle against the SAME Postgres instance that
 * also exposes `batch()`, so that branch runs for real. It uses a single
 * dedicated pooled client (not the shared pool `makeNodeDb` hands to
 * drizzle) specifically so `batch()` can wrap the statements it's given in
 * a manual BEGIN/COMMIT/ROLLBACK on ONE connection: those statements are
 * lazy, unexecuted Drizzle query objects already built against THIS SAME
 * handle by the caller's own `build(db)` step (see atomic.ts's
 * `runAtomically` doc comment for why `build` takes the target as a
 * parameter) -- nothing has hit the wire yet when `batch()` receives them,
 * so bracketing their execution in a transaction on the connection that
 * built them gives the same all-or-nothing guarantee neon-http's real
 * `db.batch()` gives production, without reimplementing Neon's HTTP
 * batching wire protocol itself (out of scope for a repository test).
 */
export async function makeBatchCapableDb(
  databaseUrl: string,
): Promise<{ db: Db; teardown: () => Promise<void> }> {
  const pool = new Pool({ connectionString: databaseUrl });
  const client: PoolClient = await pool.connect();
  const base = drizzle(client, { schema });

  const db = base as unknown as Db;
  (db as unknown as { batch: (statements: unknown[]) => Promise<unknown[]> }).batch = async (
    statements: unknown[],
  ) => {
    await client.query("BEGIN");
    try {
      const results: unknown[] = [];
      for (const statement of statements) {
        results.push(await statement);
      }
      await client.query("COMMIT");
      return results;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    }
  };

  return {
    db,
    teardown: async () => {
      client.release();
      await pool.end();
    },
  };
}
