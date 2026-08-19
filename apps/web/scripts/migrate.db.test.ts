/* --------------------------------------------------------------------------
   #340: proves the two-stage migration split in migrate.ts actually
   delivers 0035's backfill against a database that reaches 0027-0035 in a
   single deploy -- exactly the shape every real deploy target is in today
   (staging has none of 0027-0035 yet). The rest of the test suite never
   runs migrations in two batches, so this is the only place that would
   have caught the original defect: applying 0026, committing, then
   0027-0035 together and asserting `provider = 'llmoxie'`.

   Runs against scratch databases created (and dropped) for this test
   alone -- unlike every other `.db.test.ts` file, this one needs full
   control over exactly which migrations are applied and when, which the
   shared dev database (already fully migrated) can't provide.
   -------------------------------------------------------------------------- */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { runMigrations } from "./migrate";

const DATABASE_URL = process.env.DATABASE_URL;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "..", "src", "db", "migrations");
const EXTENSIONS_SQL = path.join(__dirname, "..", "src", "db", "init", "01_extensions.sql");

/** Builds a scratch migrations folder containing only entries up to (and
 *  including) the given tag -- same technique migrate.ts's own
 *  buildStageOneDir uses, generalized here so this test can stop at 0026
 *  (staging's real current state) instead of migrate.ts's own split
 *  point. */
function buildFolderThrough(uptoTag: string): string {
  const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  const cutIndex = journal.entries.findIndex((e) => e.tag === uptoTag);
  if (cutIndex === -1) throw new Error(`tag "${uptoTag}" not found in journal`);
  const entries = journal.entries.slice(0, cutIndex + 1);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llteacher-migrate-test-"));
  fs.mkdirSync(path.join(dir, "meta"));
  fs.writeFileSync(path.join(dir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }, null, 2));
  for (const entry of entries) {
    fs.copyFileSync(path.join(MIGRATIONS_DIR, `${entry.tag}.sql`), path.join(dir, `${entry.tag}.sql`));
  }
  return dir;
}

/** Creates an empty scratch database on the same Postgres server as
 *  DATABASE_URL, with the schema's required extensions applied -- ready
 *  for migrations, nothing else. */
async function createScratchDatabase(adminPool: Pool, name: string): Promise<string> {
  await adminPool.query(`CREATE DATABASE ${name}`);
  const url = new URL(DATABASE_URL!);
  url.pathname = `/${name}`;
  const scratchUrl = url.toString();
  const scratchPool = new Pool({ connectionString: scratchUrl });
  await scratchPool.query(fs.readFileSync(EXTENSIONS_SQL, "utf8"));
  await scratchPool.end();
  return scratchUrl;
}

async function dropScratchDatabase(adminPool: Pool, name: string): Promise<void> {
  // Postgres refuses DROP DATABASE while any connection is still open.
  await adminPool.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
    [name],
  );
  await adminPool.query(`DROP DATABASE IF EXISTS ${name}`);
}

describe.skipIf(!DATABASE_URL)("scripts/migrate.ts two-stage split (real DB, #340)", () => {
  let adminPool: Pool;
  const dbNames: string[] = [];

  beforeAll(() => {
    adminPool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    for (const name of dbNames) {
      await dropScratchDatabase(adminPool, name);
    }
    await adminPool.end();
  });

  it(
    "backfills a staging-state org's default llm_config to llmoxie/gpt-5.3-codex when 0027-0035 land in one deploy",
    async () => {
      const dbName = `llteacher_migrate_test_staging_${crypto.randomUUID().replace(/-/g, "")}`;
      dbNames.push(dbName);
      const scratchUrl = await createScratchDatabase(adminPool, dbName);

      // Stage 0: apply through 0026 in its own transaction -- matches
      // staging's real current state per #340 (it has never seen any of
      // 0027-0035).
      const through0026 = buildFolderThrough("0026_fluffy_redwing");
      const pool = new Pool({ connectionString: scratchUrl });
      const db = drizzle(pool);
      try {
        await migrate(db, { migrationsFolder: through0026 });

        // Seed a real org row exactly like a live 0029-backfilled config --
        // the provider/model this migration set is supposed to move off of.
        await db.execute(sql`
          INSERT INTO organizations (id, slug, name, workos_organization_id)
          VALUES ('11111111-1111-1111-1111-111111111111', 'staging-state-org', 'Staging State Org', 'org_migrate_test')
        `);
        await db.execute(sql`
          INSERT INTO llm_configs (id, organization_id, provider, model_name, temperature, max_completion_tokens, credential_id, is_default, is_active)
          VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'openrouter', 'google/gemma-4-31b-it:free', 0.7, 1000, NULL, true, true)
        `);
      } finally {
        fs.rmSync(through0026, { recursive: true, force: true });
        await pool.end();
      }

      // Stage 1+2: apply 0027-0035 as one real deploy would -- migrate.ts's
      // own two-stage split (0027-0034, then 0035 alone) is what's under
      // test here.
      await runMigrations(scratchUrl);

      const verifyPool = new Pool({ connectionString: scratchUrl });
      try {
        const verifyDb = drizzle(verifyPool);
        const rows = await verifyDb.execute<{ provider: string; model_name: string }>(sql`
          SELECT provider, model_name FROM llm_configs
          WHERE id = '22222222-2222-2222-2222-222222222222'
        `);
        expect(rows.rows[0]).toMatchObject({ provider: "llmoxie", model_name: "gpt-5.3-codex" });
      } finally {
        await verifyPool.end();
      }
    },
    60_000,
  );

  it(
    "applies cleanly from a genuinely fresh database (0001-0035 in one call, no llm_configs rows to backfill)",
    async () => {
      const dbName = `llteacher_migrate_test_fresh_${crypto.randomUUID().replace(/-/g, "")}`;
      dbNames.push(dbName);
      const scratchUrl = await createScratchDatabase(adminPool, dbName);

      await expect(runMigrations(scratchUrl)).resolves.not.toThrow();

      // Every migration recorded, including 0035 -- the safety-net
      // EXCEPTION path in 0035 fires here (nothing to back-fill on a
      // brand-new database) but must not fail the migrate run itself.
      const verifyPool = new Pool({ connectionString: scratchUrl });
      try {
        const verifyDb = drizzle(verifyPool);
        const rows = await verifyDb.execute<{ count: string }>(
          sql`SELECT count(*)::text FROM drizzle.__drizzle_migrations`,
        );
        expect(Number(rows.rows[0]!.count)).toBeGreaterThanOrEqual(35);
      } finally {
        await verifyPool.end();
      }
    },
    60_000,
  );

  it(
    "0040 backfills llm_configs.name against a POPULATED table before making it NOT NULL",
    async () => {
      // #317/#363 merge. 0040 adds llm_configs.name NOT NULL. drizzle-kit
      // generated a bare `ADD COLUMN "name" text NOT NULL`, which succeeds
      // against an empty table and fails against any row that already
      // exists -- Postgres has no value to put there. Every path CI already
      // exercises hits the empty case (the migrate step runs before the
      // seed), which is the same blind spot #348 named: "CI never exercises
      // a POPULATED database." 0040 was hand-edited to the
      // nullable -> UPDATE -> SET NOT NULL shape; this is what proves it,
      // and what fails loudly if a future regeneration flattens it back.
      const dbName = `llteacher_migrate_test_populated_${crypto.randomUUID().replace(/-/g, "")}`;
      dbNames.push(dbName);
      const scratchUrl = await createScratchDatabase(adminPool, dbName);

      // Migrate through 0039 -- staging's head, before this branch's 0040.
      const through0039 = buildFolderThrough("0039_llm_configs_price_per_million_tokens");
      const pool = new Pool({ connectionString: scratchUrl });
      const db = drizzle(pool);
      try {
        await migrate(db, { migrationsFolder: through0039 });
        // A config row of the shape 0029/0035 leave behind. No `name`
        // column exists yet at 0039, which is exactly the point.
        await db.execute(sql`
          INSERT INTO organizations (id, slug, name, workos_organization_id)
          VALUES ('33333333-3333-3333-3333-333333333333', 'populated-org', 'Populated Org', 'org_populated_test')
        `);
        await db.execute(sql`
          INSERT INTO llm_configs (id, organization_id, provider, model_name, temperature, max_completion_tokens, credential_id, is_default, is_active)
          VALUES ('44444444-4444-4444-4444-444444444444', '33333333-3333-3333-3333-333333333333', 'llmoxie', 'gpt-5.3-codex', 0.7, 1000, NULL, true, true)
        `);
      } finally {
        fs.rmSync(through0039, { recursive: true, force: true });
        await pool.end();
      }

      // Applies 0040 on top. Must not throw, and must leave the
      // pre-existing row named after its own model.
      await expect(runMigrations(scratchUrl)).resolves.not.toThrow();

      const verifyPool = new Pool({ connectionString: scratchUrl });
      try {
        const verifyDb = drizzle(verifyPool);
        const rows = await verifyDb.execute<{ name: string }>(sql`
          SELECT name FROM llm_configs WHERE id = '44444444-4444-4444-4444-444444444444'
        `);
        expect(rows.rows[0]).toMatchObject({ name: "gpt-5.3-codex" });
      } finally {
        await verifyPool.end();
      }
    },
    60_000,
  );
});
