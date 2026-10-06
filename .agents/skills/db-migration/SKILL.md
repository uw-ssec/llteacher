---
name: db-migration
description:
  Use when changing the Drizzle schema (apps/web/src/db/schema*), adding,
  renumbering, or reviewing a SQL migration under apps/web/src/db/migrations/,
  or when CI's migration-index-collision check fails.
---

# DB Migration

The database is PostgreSQL (with `pgvector`). The schema is Drizzle TypeScript
under `apps/web/src/db/schema.ts` and `apps/web/src/db/schema/`; migrations are
generated SQL in `apps/web/src/db/migrations/NNNN_<name>.sql`, tracked by
`meta/_journal.json` and `meta/NNNN_snapshot.json`. `apps/web/README.md`
("Migrations") is the long-form source; this skill is the checklist.

## Make a schema change

1. Edit the schema in `src/db/schema/<module>.ts`, and re-export a new module
   from the `src/db/schema.ts` barrel — drizzle-kit reads only the barrel. Every
   course-owned table carries `course_id` (course is the tenancy boundary; check
   `pixi run okf search --for-path <schema file>` for the constraints that
   apply).
2. Generate from `apps/web` against an up-to-date `staging` base:

   ```bash
   git fetch origin && git rebase origin/staging     # base the index on current staging
   cd apps/web && npx drizzle-kit generate --name <snake_case_description>
   ```

   (`npm run db:generate --workspace=llteacher-web` is the same command without
   a name.) Commit the `.sql`, the new `meta/NNNN_snapshot.json`, and the
   `meta/_journal.json` change together. A data-only migration with no schema
   diff is generated with `npx drizzle-kit generate --custom --name <x>` (an
   empty `.sql` you fill in); a few existing migrations have no snapshot for
   that reason.

3. Read the generated SQL. On the hot tables `conversations`, `messages`, and
   `llm_call_logs`:

   - indexes must be `CREATE INDEX CONCURRENTLY IF NOT EXISTS` — add it by hand;
     drizzle-kit never emits it (`scripts/migrate.ts` runs such statements
     outside the batched transaction);
   - any rewrite under `ACCESS EXCLUSIVE` (column type change, `ALTER TABLE`
     rewrite) needs a lighter technique (add column, backfill) or an explicit
     trade-off note in the PR.

   On any populated table, a new `NOT NULL` column is added nullable, backfilled
   with an explicit `ORDER BY` / `row_number()`, then `SET NOT NULL` — raw
   drizzle output fills in heap order (#269). The runner applies everything
   before `SPLIT_BEFORE_TAG` in `scripts/migrate.ts` in its own transaction
   because Postgres cannot use an enum value in the transaction that added it
   (55P04); move the tag if a new data migration needs a just-added enum value.
   It also rejects a `CONCURRENTLY` index without `IF NOT EXISTS`.

4. Apply and test locally (needs a local Postgres; see `run-tests`):

   ```bash
   npm run db:migrate                      # root alias for llteacher-web's db:migrate
   npm test --workspace=llteacher-web
   ```

## When CI says the migration index collides

The `migration-index-collision` job fails when your `NNNN` already exists on the
base branch under another name. **Index claims follow PR-open order** (#373):
the PR opened first keeps its index. Rebase onto the now-current `staging` and
regenerate (`npx drizzle-kit generate`), or hand-renumber the `.sql`, its
snapshot, and its journal entry, keeping the snapshot `prevId`/`id` chain
intact.

## How migrations reach production

The release workflow registers the candidate task, runs **the candidate's
migrations before activating it**, then switches traffic. So every migration
must be safe to run while the previous app version is still serving: add before
you remove, make new columns nullable or defaulted, and drop columns only in a
later release once no running code reads them.

## Rules

- NEVER edit, rename, or delete a migration that has merged to `staging`; fix
  forward with a new migration.
- NEVER hand-edit `meta/_journal.json` except to renumber your own unmerged
  migration, and never reorder its entries.
- NEVER run `drizzle-kit push` or `drizzle-kit migrate`; migrations apply only
  through `npm run db:migrate` (`scripts/migrate.ts`), which handles
  `CONCURRENTLY` statements.
- NEVER run `db:migrate` or `db:seed` against a non-local database (shared dev,
  staging, production) from an agent session; use a disposable local Postgres
  (see `run-tests`) or let CI do it.
- One migration per logical change; name it (`--name`) after what it does.

## Done

The `.sql`, snapshot, and journal entry are committed together; the SQL was read
and hot-table rules applied; `npm run db:migrate` and
`npm test --workspace=llteacher-web` pass locally (or the PR says why they could
not run), and the PR description states whether the migration is safe under the
old app version.
