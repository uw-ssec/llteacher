# Tasks 4–5 runtime report

Status: DONE_WITH_CONCERNS

## Delivered

- Added a same-session PostgreSQL advisory-lock helper. Acquisition, work, unlock, and release use one checked-out client; contention skips work; thrown work still unlocks/releases.
- Added an immediate/hourly in-process overdue scheduler with coalesced non-overlapping ticks, secret-safe failure logging, and an awaited stop.
- Integrated scheduler startup with advisory key `0x4c4c5453`; shutdown stops/awaits it before extraction drain and DB close.
- Ensured a configured `KNOWLEDGE_ROOT` exists before the HTTP server starts.
- Added repository-statement-derived invalid concurrent-index detection and exact-name recovery. A valid sentinel index is proven untouched by the real PostgreSQL test.

## TDD evidence

### Task 4 RED

`npm test --workspace=llteacher-web -- --run src/db/client.test.ts src/node/overdue-scheduler.test.ts`

- Exit 1: `withSessionAdvisoryLock is not a function` (3 tests), and `./overdue-scheduler` did not exist.

`npm test --workspace=llteacher-web -- --run src/node/server.test.ts`

- Exit 1 for the new behavior: background stop callback was not invoked, and startup did not accept/init the configured knowledge root/scheduler. One concurrent shared-tree health assertion also exposed the new version field and was relaxed to `toMatchObject`.

### Task 4 GREEN

`npm test --workspace=llteacher-web -- --run src/db/client.test.ts src/node/overdue-scheduler.test.ts src/node/server.test.ts src/server/jobs/autoSubmitOverdue.test.ts`

- Exit 0: 4 files, 32 tests passed.

### Task 5 RED

`DATABASE_URL=postgres://llteacher:dev@localhost:55432/llteacher npm test --workspace=llteacher-web -- --run scripts/migrate.db.test.ts -t 'rebuilds only'`

- Exit 1 after fixture correction: the repository-known invalid index remained `indisvalid = false` because `CREATE INDEX ... IF NOT EXISTS` did not rebuild it.

### Task 5 GREEN

`DATABASE_URL=postgres://llteacher:dev@localhost:55432/llteacher npm test --workspace=llteacher-web -- --run scripts/migrate.db.test.ts`

- Exit 0: 5 real disposable-database tests passed, including exact invalid-index recovery and preservation of a valid sentinel index.

## Additional verification

- `DATABASE_URL=postgres://llteacher:dev@localhost:55432/llteacher npm run db:migrate --workspace=llteacher-web` — exit 0, migrations applied.
- Seeded the shared disposable database with fresh in-shell OpenSSL-generated `ENCRYPTION_KEY` and `BLIND_INDEX_KEY`; no key values were printed or persisted. Exit 0, expected seed summary.
- `npm run typecheck --workspace=llteacher-web` — task-owned errors are clear, but command exits 2 on concurrent uncommitted `src/server/storage/objectStore.aws.test.ts` errors (incomplete `Env` cast and missing `S3StoreConfig` credentials).

## Commits

- `0db13d3 refactor(infra): run overdue sweep in the app task`
- `368d495 fix(db): recover invalid concurrent indexes before deploy`

## Concerns / coordination

- `recoverInterruptedExtractions` remains best-effort asynchronous, so the server and scheduler can begin while recovery is still finishing. The stop-before-start ECS deployment configuration ensures only one task is a recovery writer, but early requests can briefly observe stale `processing` rows.
- Infrastructure deletion/tests, migration shell wrapper/tests, and README documentation are intentionally owned by the other assigned implementers.
