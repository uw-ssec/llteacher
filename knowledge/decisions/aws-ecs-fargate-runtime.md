---
type: Decision
title: Node 24 on AWS ECS Fargate + RDS replaced the interim Cloudflare Workers + Neon runtime
description: "The app moved from a Cloudflare Worker over Neon's HTTP driver to one Node 24 Hono container on ECS Fargate with node-postgres to RDS PostgreSQL 16 + pgvector (issue #82, Sept 2026). AWS is settled."
tags: [infra, aws, runtime, database]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:32:34Z" }
status: stable
governance: constraint
code_refs: [apps/web/src/node/server.ts, apps/web/src/db/client.ts, apps/web/src/db/nodeClient.ts, apps/web/src/runtime/config.ts, Dockerfile.aws, infra/src/app.ts, infra/src/database.ts, docs/architecture/tech-stack.md]
sources:
  - resource: docs/superpowers/plans/2026-09-15-m12-runtime-migration-implementation.md
  - resource: docs/superpowers/plans/2026-09-15-m12-milestone-findings.md
  - resource: docs/architecture/db-driver-split.md
  - resource: docs/architecture/tech-stack.md
  - resource: commit 319cb76
  - resource: commit 5219035
  - resource: commit 65db7e7
  - resource: "PR #458"
---

## Spec proposed
The 2026-06 port plan targeted Cloudflare Workers with static assets, Neon Postgres over `@neondatabase/serverless` HTTP, and Wrangler deploys. The M12 milestone (epic #66) later set AWS readiness as the outcome: Pulumi-managed RDS, S3, and Secrets Manager, with Cloudflare and Neon removed. The user has confirmed AWS + Pulumi as the settled target. Workers + Neon were interim only.

## Implemented
- `apps/web/src/node/server.ts` runs Hono through `@hono/node-server` and serves both SPA builds. The Worker entry, `scheduled()` export, `ASSETS` binding, and Wrangler deploy script were removed (commits `319cb76` and `65db7e7`, 2026-09-15/16).
- `apps/web/src/db/client.ts` `makeDb` is now node-postgres with a `Pool` cached per URL. `nodeClient.ts` `makeNodeDb` survives only as an *unpooled* client for tests and seeding. The old reason for the driver split (neon-http cannot reach plain Postgres) is retired, per `docs/architecture/db-driver-split.md`.
- Runtime config comes from `process.env`, validated by `src/runtime/config.ts` and injected by ECS from Secrets Manager.
- `Dockerfile.aws` builds a pinned `node:24-bookworm-slim` multi-stage image that bundles the pinned `okf` binary.
- The infra target is RDS PostgreSQL 16 (encrypted, 20 GiB, 7-day backups in production) in `us-west-2`.

## Why
The M12 findings say ECS/Fargate "avoids Lambda-specific changes to streamed chat responses, retains normal long-lived Postgres pooling". The OKF knowledge base also needs a filesystem and process spawning, which the Worker cannot provide.

## Rejected alternatives
- Staying on Workers + Neon.
- Lambda.
- A future Cloudflare move is called out as "a separate replatforming", not a toggle.

## Consequences
- The earlier Worker-era workarounds no longer apply: neon-http has no `transaction()`, and `runAtomically` feature-detects `batch()` against `transaction()`. They stay in the code as harmless.
- Comments and docs that still say "Worker", "Wrangler", or "Neon" (for example `apps/web/ARCHITECTURE.md` "Deploy Order", `docs/architecture/webr-self-hosting.md`) are historical.
- The legacy root `Dockerfile` is the Django image. The AWS image is `Dockerfile.aws`.

# Related Concepts
- [Why the app left Cloudflare Workers and Neon: constraints that shaped the code](../facts/cloudflare-to-aws-replatform-lessons.md): Why the interim Cloudflare/Neon stack was left
- [AWS infrastructure topology (Pulumi, ECS Fargate)](../architecture/infra-topology.md): The AWS topology as built
- [One ECS task serves the student app, instructor console, and API, with stop-before-start replacement](single-task-full-app-service.md): One task serves everything
- [All regional AWS resources live in us-west-2, and deploys refuse a stack whose region is stale](../requirements/aws-region-us-west-2.md): Region constraint for all AWS resources
- [Workers/Neon-era comments and docs are stale](../facts/code-stale-workers-era-docs.md): Docs and comments still describing the Workers era
