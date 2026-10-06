---
name: run-tests
description:
  Use when running the TypeScript, infra, eval, or legacy Django tests, a single
  test file, or a failing test — after changing app code, before claiming it
  works, or when reading vitest or node:test output.
---

# Run Tests

Run tests through npm/turbo from the repository root with Node 24 (`.nvmrc`),
after `npm ci`. Read the summary lines, not the exit code alone.

## Commands

| Scope                | Command                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------- |
| Everything (turbo)   | `npm test`                                                                                                 |
| apps/web             | `npm test --workspace=llteacher-web`                                                                       |
| apps/admin           | `npm test --workspace=llteacher-admin`                                                                     |
| packages/ui          | `npm test --workspace=@llteacher/ui`                                                                       |
| evals (fixture-only) | `npm test --workspace=evals`                                                                               |
| infra                | `npm test --workspace=infra` (vitest, then `node --test scripts/*.test.mjs`)                               |
| One file             | `cd apps/web && npx vitest run src/lib/prompts.test.ts`                                                    |
| Fresh run, no cache  | `npm test -- --force`                                                                                      |
| Infra shell tests    | `for t in infra/scripts/*.test.sh; do bash "$t" >/dev/null 2>&1 && echo "ok $t" \|\| echo "FAIL $t"; done` |
| Legacy Django        | `uv run python run_tests.py --settings=src.llteacher.test_settings [apps.<app>.tests.<module>]`            |

The infra shell tests stub `pulumi`, `docker`, `aws`, and `curl`, so they need
no credentials (`docker-image-aws.test.sh` needs a running Docker daemon). They
are not part of `npm test` or CI. Django tests use in-memory SQLite and no CI
job runs them; they say nothing about the TypeScript product.

## Database-backed tests

About 489 `apps/web` tests use `describe.skipIf(!DATABASE_URL)` and **skip
silently** without a database. A green local run without `DATABASE_URL` did not
exercise repositories, SQL, migrations, or the seed. To run them, use a
disposable local PostgreSQL with pgvector (the CI recipe):

```bash
docker run -d --name llt-pg -e POSTGRES_USER=llteacher -e POSTGRES_PASSWORD=dev \
  -e POSTGRES_DB=llteacher -p 5432:5432 pgvector/pgvector:pg16
export DATABASE_URL=postgres://llteacher:dev@localhost:5432/llteacher
export ENCRYPTION_KEY="$(openssl rand -base64 32)" BLIND_INDEX_KEY="$(openssl rand -base64 32)"
psql "$DATABASE_URL" -f apps/web/src/db/init/01_extensions.sql
npm run db:migrate
npm test -- --force
```

`--force` matters: those three variables are part of turbo's cache key, and a
cached pass replays without running anything.

## Reading the output

- turbo: `Tasks: 5 successful, 5 total`. vitest: `Test Files N passed` and the
  skipped count. node:test: `ℹ fail 0`.
- `WARNING no output files found for task ...#test` is harmless.
- `Cannot find module '@aws-sdk/client-s3'` (or any TS2307 for a listed
  dependency): stale `node_modules`; run `npm ci`.
- Real-okf knowledge tests run against whatever `okf` is on PATH (or
  `OKF_BINARY`); CI pins v0.3.0, so a pass with another version is not proof.
- A failing assertion prints both sides. Fix the code or the expectation
  deliberately; never widen a matcher or delete an assertion to get green.

## Flaky tests

None recorded. If a test passes and fails without a code change, file an issue
with the `create-issue` skill and say so in the PR. Never mark it `.skip` or
`.todo` silently.

## Rules

- NEVER point `DATABASE_URL` at the shared dev database, staging, or production;
  DB tests insert and truncate data.
- NEVER loosen `infra/scripts/release-workflow.test.mjs` or
  `aws-release.test.mjs` to make them pass; they encode reviewed security
  invariants of `release.yml`.
- Never claim a repository, SQL, migration, or seed change is tested from a run
  without `DATABASE_URL`; say the DB suites were skipped.

## Done

The command exited 0 and its summary lines (with the skipped count) are pasted
into your report. One failure means not done.
