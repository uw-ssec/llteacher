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

   -------------------------------------------------------------------------

   Second exception -- #372. `CREATE INDEX CONCURRENTLY` refuses to run
   inside a transaction block at all (not a lock-contention problem, a hard
   SQLSTATE 25001 from Postgres), and drizzle's migrator batches every
   pending migration in a folder into exactly one transaction (see
   pg-core/dialect.ts's `PgDialect.migrate`, `session.transaction(...)`
   wrapping the whole loop). A migration file containing a CONCURRENTLY
   statement can't be handed to that transaction as-is.

   applyMigrationsFolder() below is the general form of this file's own
   split trick: before calling drizzle's `migrate()` on a folder, it scans
   every entry for a `CREATE INDEX CONCURRENTLY` statement, builds a
   scratch copy of the folder with those statements stripped out (so
   drizzle's batched transaction never sees them), runs the transactional
   remainder through `migrate()` as normal, then runs each stripped
   statement directly against the pool -- no transaction, after the rest
   of the folder has committed.

   This intentionally does NOT try to track "already applied" for the
   CONCURRENTLY statements the way drizzle's own migrations table does --
   every call to applyMigrationsFolder() re-scans the WHOLE folder handed
   to it, so a CONCURRENTLY statement from an old, already-applied
   migration runs again on every future invocation. That's a real, if
   negligible, cost (a duplicate-name catalog check on the CREATE INDEX
   CONCURRENTLY IF NOT EXISTS syntax, not a rebuild) -- filtering to only
   newly-pending entries would mean duplicating drizzle's own
   created_at-comparison logic here and keeping it in sync forever. The
   convention (apps/web/README.md's "Migrations" section) makes `IF NOT
   EXISTS` mandatory on every CONCURRENTLY index specifically so this is
   always a no-op re-check, never a re-build.
   -------------------------------------------------------------------------- */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
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

// #372: drizzle's own migrator splits a migration file into statements on
// exactly this marker (migrator.js's `readMigrationFiles`) -- matched here
// so a CONCURRENTLY statement is identified the same way drizzle would
// have executed it.
const STATEMENT_BREAKPOINT = "--> statement-breakpoint";
const CONCURRENT_INDEX_PATTERN = /^\s*create\s+index\s+concurrently/i;

/** Splits one migration file's raw SQL into the statements safe to run
 *  inside drizzle's batched transaction, and any `CREATE INDEX
 *  CONCURRENTLY` statements, which are not (Postgres refuses them inside
 *  a transaction block outright). */
function splitConcurrentStatements(sqlContent: string): { transactional: string; concurrent: string[] } {
  const statements = sqlContent.split(STATEMENT_BREAKPOINT);
  const concurrent: string[] = [];
  const transactional: string[] = [];
  for (const statement of statements) {
    if (CONCURRENT_INDEX_PATTERN.test(statement)) {
      concurrent.push(statement.trim());
    } else {
      transactional.push(statement);
    }
  }
  return { transactional: transactional.join(STATEMENT_BREAKPOINT), concurrent };
}

/** Scans every entry in `migrationsFolder` for `CREATE INDEX CONCURRENTLY`
 *  statements. Returns `null` when none exist (the common case), so the
 *  caller can skip the scratch-folder machinery entirely. Otherwise
 *  returns a scratch copy of the folder with those statements stripped
 *  out of their files' content -- safe to hand to drizzle's `migrate()`
 *  -- plus the extracted statements themselves, in file order. */
function prepareFolderForConcurrentIndexes(
  migrationsFolder: string,
): { folder: string; concurrentStatements: string[] } | null {
  const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as Journal;

  const concurrentStatements: string[] = [];
  const contentByTag = new Map<string, string>();
  let anyConcurrent = false;
  for (const entry of journal.entries) {
    const content = fs.readFileSync(path.join(migrationsFolder, `${entry.tag}.sql`), "utf8");
    const { transactional, concurrent } = splitConcurrentStatements(content);
    if (concurrent.length > 0) {
      anyConcurrent = true;
      concurrentStatements.push(...concurrent);
      contentByTag.set(entry.tag, transactional);
    } else {
      contentByTag.set(entry.tag, content);
    }
  }
  if (!anyConcurrent) {
    return null;
  }

  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "llteacher-migrate-concurrent-"));
  fs.mkdirSync(path.join(scratchDir, "meta"));
  fs.writeFileSync(path.join(scratchDir, "meta", "_journal.json"), JSON.stringify(journal, null, 2));
  for (const entry of journal.entries) {
    fs.writeFileSync(path.join(scratchDir, `${entry.tag}.sql`), contentByTag.get(entry.tag)!);
  }
  return { folder: scratchDir, concurrentStatements };
}

/** Applies one migrations folder, the way `runMigrations` applies both of
 *  its stages. Transparent pass-through to drizzle's own `migrate()` for
 *  the common case; when the folder contains a `CREATE INDEX
 *  CONCURRENTLY` statement (#372), that statement is stripped out before
 *  `migrate()` ever sees it and run separately, directly against the
 *  pool, after the rest of the folder's migrations have committed. */
export async function applyMigrationsFolder(
  pool: Pool,
  db: NodePgDatabase,
  migrationsFolder: string,
): Promise<void> {
  const prepared = prepareFolderForConcurrentIndexes(migrationsFolder);
  if (!prepared) {
    await migrate(db, { migrationsFolder });
    return;
  }
  try {
    await migrate(db, { migrationsFolder: prepared.folder });
    for (const statement of prepared.concurrentStatements) {
      await pool.query(statement);
    }
  } finally {
    fs.rmSync(prepared.folder, { recursive: true, force: true });
  }
}

export async function runMigrations(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool);
  const stageOneDir = buildStageOneDir();
  try {
    await applyMigrationsFolder(pool, db, stageOneDir);
    await applyMigrationsFolder(pool, db, MIGRATIONS_DIR);
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
