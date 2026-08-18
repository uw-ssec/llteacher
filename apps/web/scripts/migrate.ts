/* --------------------------------------------------------------------------
   Custom migration runner -- #340.

   `drizzle-kit migrate` (and the drizzle-orm migrator it calls into,
   pg-core/dialect.ts's PgDialect.migrate) batches EVERY pending migration
   into ONE transaction. Postgres forbids using an enum value within the
   same transaction that added it via `ALTER TYPE ... ADD VALUE` (SQLSTATE
   55P04) -- and migration 0028 adds 'llmoxie' to llm_provider /
   credential_provider, while 0035 uses that literal in a data backfill.

   On any database that already has 0001-0034 applied from an earlier,
   separate deploy, that's a non-issue: only 0035 is "pending", so it gets
   its own transaction and 'llmoxie' is already committed. But #340's whole
   finding is that this is NOT true of every real deploy target today --
   `staging` has never seen any of 0027-0035, so a single `drizzle-kit
   migrate` invocation there would batch 0028 and 0035 together exactly like
   a from-scratch database does, and the backfill would silently (or, after
   0035's own fix, loudly) fail to apply.

   This script applies migrations in two stages instead, so 0035 is NEVER in
   the same transaction as 0028 on any database, old or new:
     1. Every migration strictly before SPLIT_BEFORE, in its own
        transaction -- via a scratch directory holding just that prefix of
        the real migrations folder (drizzle's own migrator has no "apply up
        to X" option, only "apply everything in this folder").
     2. Every migration in the real folder -- drizzle's own tracking table
        (`__drizzle_migrations`) means this naturally applies only what
        stage 1 didn't reach (SPLIT_BEFORE onward on a fresh database;
        nothing at all on a database that already had 0001-0034).

   Update SPLIT_BEFORE (and this comment) the next time a data migration
   needs a value from an enum extended earlier in the same deploy -- this
   is a real, if rare, recurring hazard with native Postgres enums, not a
   one-off fixed forever by today's fix.
   -------------------------------------------------------------------------- */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "..", "src", "db", "migrations");

const SPLIT_BEFORE_TAG = "0035_llmoxie_default_config";

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}
interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

/** Builds a scratch migrations folder (same shape drizzle's migrator reads:
 *  `meta/_journal.json` + one `<tag>.sql` per entry) containing only the
 *  entries strictly before SPLIT_BEFORE_TAG, copied verbatim from the real
 *  folder -- same `when` timestamps, so stage 2's tracking-table check
 *  against the real folder lines up exactly with what stage 1 recorded. */
function buildStageOneDir(): string {
  const journalPath = path.join(MIGRATIONS_DIR, "meta", "_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as Journal;
  const splitIndex = journal.entries.findIndex((e) => e.tag === SPLIT_BEFORE_TAG);
  if (splitIndex === -1) {
    throw new Error(`scripts/migrate.ts: SPLIT_BEFORE_TAG "${SPLIT_BEFORE_TAG}" not found in the migrations journal`);
  }
  const stageOneEntries = journal.entries.slice(0, splitIndex);

  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "llteacher-migrate-stage1-"));
  fs.mkdirSync(path.join(stageDir, "meta"));
  fs.writeFileSync(
    path.join(stageDir, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries: stageOneEntries }, null, 2),
  );
  for (const entry of stageOneEntries) {
    fs.copyFileSync(path.join(MIGRATIONS_DIR, `${entry.tag}.sql`), path.join(stageDir, `${entry.tag}.sql`));
  }
  return stageDir;
}

export async function runMigrations(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool);
  const stageOneDir = buildStageOneDir();
  try {
    await migrate(db, { migrationsFolder: stageOneDir });
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    fs.rmSync(stageOneDir, { recursive: true, force: true });
    await pool.end();
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set");
  }
  await runMigrations(databaseUrl);
  console.log("Migrations applied successfully.");
}

// Only run when invoked directly (`npm run db:migrate`) -- migrate.test.ts
// imports runMigrations without triggering this.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
