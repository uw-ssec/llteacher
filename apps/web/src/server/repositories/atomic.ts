import type { Db } from "../../db/client";

/** One statement in an atomic group. Drizzle's query-builder objects are
 *  thenable, so the same value works both as a `db.batch()` item and as
 *  something a transaction body can await. */
export type BatchStatement = Parameters<Db["batch"]>[0][number];

/** Runs a group of writes all-or-nothing across both drivers this repo uses.
 *
 *  Production is neon-http, which has `db.batch()` and no `db.transaction()`.
 *  The node-postgres client real-DB tests and the seed script use
 *  (`makeNodeDb`) is the mirror image: `db.transaction()` works and
 *  `db.batch` is absent at runtime, despite the shared `Db` type claiming
 *  otherwise. Feature-detect rather than try/catch -- a missing method is a
 *  TypeError at the call site, not an error to catch.
 *
 *  `build` receives the handle its statements must be bound to: the outer db
 *  on the batch path, the transaction handle on the fallback path. Building
 *  against the outer db inside a transaction would run the writes outside it,
 *  which is precisely the bug this signature exists to make unwriteable --
 *  hence a callback rather than a plain statement array.
 *
 *  repositories/homeworks.ts's updateHomework predates this helper and keeps
 *  its own inline copy of the same branch. It is deliberately not migrated:
 *  its two paths have structurally different bodies (one defers statements
 *  into an array, the other awaits them against `tx` as it goes), so it needs
 *  a callback-per-statement shape this helper does not have. Tracked with the
 *  rest of the idiom drift in #202. */
export async function runAtomically(
  db: Db,
  build: (target: Db) => BatchStatement[],
): Promise<void> {
  if (typeof db.batch === "function") {
    const statements = build(db);
    // Don't hand batch() an empty tuple -- its type is [U, ...U[]], and an
    // empty round-trip is pure cost.
    if (statements.length === 0) return;
    await db.batch(statements as [BatchStatement, ...BatchStatement[]]);
    return;
  }

  await db.transaction(async (tx) => {
    for (const statement of build(tx as unknown as Db)) {
      await statement;
    }
  });
}
