---
type: Architecture
title: In-process background work and shutdown lifecycle
description: "The single Node task runs the overdue-submission sweep at startup and hourly under a session advisory lock, recovers interrupted extractions at boot, and shuts down within one 25s budget; multiple replicas are unsupported."
tags: [architecture, jobs, lifecycle, ecs]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:30:53Z" }
status: stable
governance: constraint
code_refs: ["apps/web/src/node/server.ts", "apps/web/src/node/overdue-scheduler.ts", "apps/web/src/node/run-overdue-job.ts", "apps/web/src/server/jobs/autoSubmitOverdue.ts", "apps/web/src/db/client.ts", "apps/web/src/server/knowledge/extract"]
sources:
  - resource: "apps/web/src/node/server.ts"
  - resource: "apps/web/README.md"
  - resource: "infra/README.md"
---

There is no separate worker, queue, EventBridge rule or scheduled ECS task. Everything runs inside the one app process:

- **Overdue sweep.** `startOverdueScheduler` runs `autoSubmitOverdueSections(db)` at startup and hourly, wrapped in `withSessionAdvisoryLock(0x4c4c5453 /* "LLTS" */)` so two processes never sweep concurrently. A manual one-shot exists: `npm run node:run-overdue-job`. The job follows the repository/scope rules: it enumerates tenants with `listAllOrgScopes` and does all work per-OrgScope.
- **Extraction recovery.** Before serving, `recoverInterruptedExtractions` flips materials stuck in `processing` to `failed` with a reason (best-effort; failure does not block startup).
- **Shutdown.** SIGINT/SIGTERM -> `closeNodeServer` with ONE 25s deadline shared across HTTP close, scheduler stop, `drainExtractions(20s)` and `closeDb()` (ECS gives 30s). On deadline it force-closes connections and exits 1; interrupted extractions become retryable on next boot.

**DB pool.** `makeDb(url)` in `db/client.ts` is a process singleton (`pg.Pool`, max 10). Calling it with a different URL while the pool is open throws; call `closeDb()` first. Tests and scripts use `makeNodeDb` (db/nodeClient.ts) for independent pools. The `Db` type still advertises a `batch()` method from the neon-http era; node-postgres has none at runtime and repository code feature-detects it and uses transactions.

**Single-writer assumption.** Knowledge write locks, extraction ownership and the in-memory queue all assume exactly one task. ECS is configured with `desiredCount` 1 and `deploymentMinimumHealthyPercent: 0` (stop-before-start), so releases have brief downtime. Scaling out requires shared job ownership and coordinated recovery first.
