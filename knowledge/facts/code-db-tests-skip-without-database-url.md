---
type: Fact
title: DB-backed tests silently skip without DATABASE_URL
description: "About 490 apps/web tests (34 files: *.db.test.ts and many repository tests) use describe.skipIf(!DATABASE_URL); npm test passes locally without a database, so green locally does not mean repository code was exercised."
tags: [testing, vitest, database, gotcha]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:30:53Z" }
status: stable
governance: constraint
code_refs: ["apps/web/vitest.config.ts", "apps/web/src/db/nodeClient.ts", "apps/web/src/server/repositories", "apps/web/scripts/migrate.db.test.ts", "turbo.json"]
sources:
  - resource: "apps/web/src/server/repositories/roster.test.ts"
  - resource: ".github/workflows/test.yml"
  - resource: "turbo.json"
---

Measured on a clean `npm ci` of HEAD with `DATABASE_URL` unset: `npm test` passed in about 55s, but apps/web reported `113 passed | 34 skipped` files and `2040 passed | 489 skipped` tests. Skipped suites include `repositories/conversations.test.ts` (70), `roster.test.ts`, `courseMemberships.test.ts`, `llmConfigs.test.ts`, `sectionConversations.db.test.ts`, `db/schema/runtime.test.ts`, `jobs/autoSubmitOverdue.db.test.ts`, `lib/prompts.db.test.ts`, `scripts/migrate.db.test.ts`, `routes/exports.test.ts`, `canvasProvisioning.integration.test.ts`.

Pattern: `const DATABASE_URL = process.env.DATABASE_URL; describe.skipIf(!DATABASE_URL)(...)`, with `makeNodeDb(DATABASE_URL!)` for an independent pool. File naming is not a reliable signal: many non-`.db.` repository tests are DB-gated too.

**To run them locally** you need a Postgres 16 with pgvector, migrated:

```bash
export DATABASE_URL=postgres://llteacher:dev@localhost:5432/llteacher
export ENCRYPTION_KEY=$(openssl rand -base64 32) BLIND_INDEX_KEY=$(openssl rand -base64 32)
psql "$DATABASE_URL" -f apps/web/src/db/init/01_extensions.sql
npm run db:migrate
npm test   # or: npm test --workspace=llteacher-web
```

(CI uses the `pgvector/pgvector:pg16` image with that exact URL.) The DB tests write and truncate data: point them only at a disposable local DB, never shared dev Neon, staging or production.

**turbo caching:** the `test` task declares `env: ["DATABASE_URL", "ENCRYPTION_KEY", "BLIND_INDEX_KEY"]`, so these vars are in the cache hash. A cached "pass" from a run without a DB will not be replayed for a run with one, and vice versa. Use `--force` to bypass the cache when in doubt.

Similarly, real-okf tests (`okfCli.test.ts`, `persistent-service.test.ts`) use `describe.skipIf(!okfAvailable(OKF))` and run against whatever `okf` is on PATH (or `OKF_BINARY`).

Other workspace counts at HEAD: ui 309, admin 454, evals 47 (+6 skipped), infra vitest 59 + node:test 99 (1 skipped).
