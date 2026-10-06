---
type: Bug
title: Interrupted CREATE INDEX CONCURRENTLY leaves an INVALID index that IF NOT EXISTS skips
description: "migrate.ts runs CONCURRENTLY index builds outside drizzle's transaction relying on IF NOT EXISTS; an interrupted build leaves an INVALID index that satisfies IF NOT EXISTS forever, so retries never rebuild it."
tags: [database, migrations, postgres, deploy]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:25:31Z" }
status: stable
governance: constraint
code_refs: ["apps/web/scripts/migrate.ts", "apps/web/scripts/migrate.db.test.ts", "apps/web/src/db/migrations"]
sources:
  - resource: "issue #376"
  - resource: "issue #244"
  - resource: "PR #461"
---

## Background

`apps/web/scripts/migrate.ts` pulls `CREATE INDEX CONCURRENTLY` statements out of drizzle's batched transaction, because CONCURRENTLY cannot run inside a transaction, and runs them directly on the pool afterwards. It re-scans every migration on every run and relies on a convention that these statements use `IF NOT EXISTS`, so a retry is a cheap no-op.

## Failure mode (#376)

When a concurrent index build fails partway (deadlock, conflicting long transaction, cancelled deploy), Postgres leaves an **invalid** index behind rather than nothing. That catalog entry:

- is not used by the planner,
- is still maintained on every write, and
- satisfies `IF NOT EXISTS` on every later run.

So the self-healing assumption breaks in exactly the case it was meant for. You pay write overhead forever, get no read benefit, and `db:migrate` reports success.

## Fix (PR #461)

Before applying migrations, `migrate.ts` checks `pg_index.indisvalid = false` for the known concurrent indexes, drops the invalid index and rebuilds it. `migrate.db.test.ts` covers this against a real interrupted-index scenario. PR #461 also requires concurrent-index migrations to be safe to replay.

## Related (#244, open)

Migration 0021 added a UNIQUE constraint on `conversations` and a unique index on `submissions` without CONCURRENTLY. Both take ACCESS EXCLUSIVE locks, which means a write outage on the highest-growth table during a deploy once data volume is real. The open question is whether to standardise `CREATE UNIQUE INDEX CONCURRENTLY` plus `ADD CONSTRAINT ... USING INDEX`.

## Rule

Any new CONCURRENTLY index must use `IF NOT EXISTS`, be idempotent, and be covered by the invalid-index recovery. For big tables, prefer online builds.
