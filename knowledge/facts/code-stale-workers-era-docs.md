---
type: Fact
title: Workers/Neon-era comments and docs are stale
description: "The app moved from Cloudflare Workers + neon-http to Node + pg on ECS, but ~57 non-test apps/web files plus ARCHITECTURE.md, apps/admin/README.md and .dev.vars still reference wrangler, Worker, Neon or db.batch."
tags: [documentation, legacy, gotcha, runtime]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:30:53Z" }
status: stable
governance: context
code_refs: ["apps/web/ARCHITECTURE.md", "apps/admin/README.md", "apps/web/.dev.vars.example", "apps/web/src/db/client.ts", "apps/web/src/db/init/01_extensions.sql", "apps/web/src/server/testing/batchCapableDb.ts"]
sources:
  - resource: "apps/web/src/db/client.ts"
  - resource: "apps/web/src/runtime/config.ts"
  - resource: "5ff05e1"
  - resource: "b1174be"
---

The port first targeted Cloudflare Workers with the Neon serverless HTTP driver, then switched to a Node 24 Hono server with node-postgres on AWS ECS Fargate (`5ff05e1 refactor(web): use Node runtime configuration and pg`, `b1174be feat(deploy): package app and overdue job for ECS`). Much prose was not updated. Trust code over comments when they conflict.

Known stale statements:

- **apps/web/ARCHITECTURE.md:** jobs triggered by a "Cloudflare Cron Trigger (`triggers.crons` in `wrangler.jsonc`)" (now an in-process hourly scheduler); "`db.batch`, since `neon-http` has no `db.transaction`" and "~six Neon HTTP round-trips per turn ... no connection pooling" (now a pg Pool, max 10); "`npm run deploy` runs `db:migrate` first ... do not call `wrangler deploy`" (now release.yml + run-aws-migrations.sh). The invariants themselves (tenancy, ordering, migrate-first) still hold.
- **apps/admin/README.md:** "minimal scaffold", "No Cloudflare Worker", styles copied not shared. The console is fully built and uses `@llteacher/ui`.
- **apps/web/.dev.vars / .dev.vars.example:** a Wrangler convention. The Node app does not read it; it mentions "Neon Object Storage" and MinIO, while the current local storage path is Floci S3 or the real bucket.
- **db/init/01_extensions.sql:** lists Neon dev branches and "UW-issued Neon project" as targets; production is RDS.
- **Code comments** across routes/repositories say "Worker", "Workers runtime" or "neon-http"; `evals/tsconfig.json` mentions `@cloudflare/workers-types`; `apps/web/tsconfig.worker.json` keeps its name but now types the Node server.
- **Compatibility leftovers in code:** the `Db` type keeps a `batch()` member that does not exist at runtime on node-postgres; repository code feature-detects it and falls back to transactions (`server/testing/batchCapableDb.ts` exists for tests). `c.env` bindings are a Workers idiom fed by `loadRuntimeConfig`.

Per project memory, Cloudflare Workers + Neon are interim-only and AWS + Pulumi is settled. When editing a file with a stale comment, correcting it is welcome but keep the change scoped.
