/* --------------------------------------------------------------------------
   #269: migration 0023's original "ADD COLUMN seq bigserial NOT NULL" had no
   ordered backfill, so a pre-existing table's seq values landed in Postgres's
   physical heap-scan order -- which has no relationship to insertion order,
   let alone created_at. This replays the ACTUAL migration file (not a copy)
   against a schema-local "messages" table seeded with rows whose insertion
   order disagrees with created_at order, and asserts the fixed migration
   still produces seq values that sort identically to created_at.
   -------------------------------------------------------------------------- */

import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

const DATABASE_URL = process.env.DATABASE_URL;

const MIGRATION_SQL = readFileSync(join(__dirname, "0023_chunky_scarecrow.sql"), "utf-8");
const STATEMENTS = MIGRATION_SQL.split("--> statement-breakpoint").map((s) => s.trim());

describe.skipIf(!DATABASE_URL)("migration 0023 seq backfill (#269, real DB)", () => {
  let schemaName: string | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    if (client && schemaName) {
      await client.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await client.end();
    }
    client = undefined;
    schemaName = undefined;
  });

  it("backfills seq to match created_at order, not insertion/heap order", async () => {
    schemaName = `test_0023_${crypto.randomUUID().replace(/-/g, "")}`;
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();

    await client.query(`CREATE SCHEMA "${schemaName}"`);
    await client.query(`SET search_path TO "${schemaName}", public`);

    // Pre-migration shape: just enough columns for the migration's UPDATE to
    // have something to key off. Real "messages" has more, but seq/
    // client_message_id are additive columns -- the migration's substance
    // doesn't read role/parts/conversation_id.
    // conversation_id has no FK here (nothing to point at in this schema) --
    // the migration's index-creation statements just need the column to
    // exist, and its UPDATE doesn't reference it at all.
    await client.query(`
      CREATE TABLE "messages" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "conversation_id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" timestamp with time zone NOT NULL
      )
    `);

    // Insert in an order that disagrees with created_at -- on a freshly
    // created table this insertion order IS the heap order, so a plain
    // "ADD COLUMN seq bigserial" (no backfill) would assign 1/2/3 in this
    // (wrong) insertion order rather than created_at order.
    const t1 = new Date("2026-01-01T00:00:00Z");
    const t2 = new Date("2026-01-02T00:00:00Z");
    const t3 = new Date("2026-01-03T00:00:00Z");
    const insertOrder = [
      { label: "third-by-time-inserted-first", created_at: t3 },
      { label: "first-by-time-inserted-second", created_at: t1 },
      { label: "second-by-time-inserted-third", created_at: t2 },
    ];
    const ids: string[] = [];
    for (const row of insertOrder) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO "messages" ("created_at") VALUES ($1) RETURNING "id"`,
        [row.created_at],
      );
      ids.push(rows[0]!.id);
    }

    for (const statement of STATEMENTS) {
      if (!statement) continue;
      await client.query(statement);
    }

    const { rows: bySeq } = await client.query<{ id: string }>(`SELECT "id" FROM "messages" ORDER BY "seq"`);
    const { rows: byCreatedAt } = await client.query<{ id: string }>(
      `SELECT "id" FROM "messages" ORDER BY "created_at", "id"`,
    );

    expect(bySeq.map((r) => r.id)).toEqual(byCreatedAt.map((r) => r.id));

    // And explicitly: seq order is NOT insertion order (that's the bug this
    // guards against -- a test that only checked seq is populated would
    // pass even with the original unordered bigserial default).
    expect(bySeq.map((r) => r.id)).not.toEqual(ids);

    const { rows: notNull } = await client.query<{ seq: string }>(`SELECT "seq" FROM "messages" WHERE "seq" IS NULL`);
    expect(notNull).toHaveLength(0);

    // Round-4 review finding: every assertion above passes whether the
    // migration's `setval(..., max + 1, false)` is correct or off by one
    // (e.g. `true` instead of `false`, or a missing `+ 1`) -- none of them
    // exercise the sequence's own next-value state, only the backfilled
    // column. `is_called = false` means the NEXT nextval() call returns
    // the given value itself; get that wrong and a genuinely new row after
    // the migration collides with (or skips past) an already-backfilled
    // seq instead of continuing cleanly from the max. A real post-migration
    // INSERT is the only way to catch that -- it must both come out ahead
    // of every backfilled seq and use the exact next integer, not just any
    // integer greater than the max.
    const maxBackfilledSeq = Math.max(...bySeq.map((_, i) => i + 1)); // 1..N, N == bySeq.length
    const { rows: freshRow } = await client.query<{ seq: string }>(
      `INSERT INTO "messages" ("created_at") VALUES (now()) RETURNING "seq"`,
    );
    expect(Number(freshRow[0]!.seq)).toBe(maxBackfilledSeq + 1);
  });
});
