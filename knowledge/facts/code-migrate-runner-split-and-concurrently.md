---
type: Fact
title: "scripts/migrate.ts: two-stage apply and CONCURRENTLY handling"
description: "Always apply migrations with npm run db:migrate (custom runner), never drizzle-kit migrate: it splits at 0035 for enum-in-transaction safety and runs CREATE INDEX CONCURRENTLY IF NOT EXISTS outside the transaction."
tags: [drizzle, migrations, postgres, gotcha]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:32:35Z" }
status: stable
governance: constraint
code_refs: [apps/web/scripts/migrate.ts, apps/web/scripts/migrate.test.ts, apps/web/scripts/migrate.db.test.ts, apps/web/src/db/init/01_extensions.sql]
sources:
  - resource: apps/web/scripts/migrate.ts
  - resource: apps/web/README.md
  - resource: cc47407
---

drizzle's migrator (and `drizzle-kit migrate`) batches EVERY pending migration into ONE transaction. Two Postgres rules break under that, so `apps/web/scripts/migrate.ts` (`npm run db:migrate`) exists:

1. **Enum values cannot be used in the transaction that added them** (SQLSTATE 55P04). Migration 0028 adds `'llmoxie'` to `llm_provider`/`credential_provider`; 0035 backfills with it. On a fresh DB (or staging, which had never seen 0027-0035) both would be pending together. The runner applies everything strictly before `SPLIT_BEFORE_TAG = "0035_llmoxie_default_config"` from a scratch copy of the folder first, then the full folder. If a future data migration needs an enum value added earlier in the same deploy, move `SPLIT_BEFORE_TAG` and update the comment. The runner throws if the tag is missing from the journal.
2. **`CREATE INDEX CONCURRENTLY` cannot run in a transaction** (SQLSTATE 25001). `applyMigrationsFolder` strips CONCURRENTLY statements out of a scratch copy, runs the rest through drizzle, then runs each stripped statement directly on the pool. These re-run on every `db:migrate` (not tracked), so a preflight (`validateConcurrentIndexStatements`) refuses any CONCURRENTLY index without `IF NOT EXISTS`.

Also: the runner executes `CREATE EXTENSION IF NOT EXISTS vector` before migrating. CI additionally applies `apps/web/src/db/init/01_extensions.sql` with psql first.

**Hot-table rule (#372).** `conversations`, `messages` and `llm_call_logs` are written on every chat turn. drizzle-kit never emits CONCURRENTLY; add `CONCURRENTLY IF NOT EXISTS` by hand to index builds on these tables. For rewrites (`ALTER COLUMN ... TYPE`), prefer add-column-then-backfill and call out any unavoidable ACCESS EXCLUSIVE lock in the PR.

Requirements: `DATABASE_URL` (fails with "DATABASE_URL is not set"). The runner also detects invalid concurrent indexes left by a failed build and rebuilds them. `migrate.db.test.ts` copies the real migration files and runs them against `DATABASE_URL` (skipped without it).

# Related Concepts
- [Interrupted CREATE INDEX CONCURRENTLY leaves an INVALID index that IF NOT EXISTS skips](../bugs/invalid-concurrent-index-skipped.md): An interrupted CONCURRENTLY build
