---
type: Fact
title: "Why the app left Cloudflare Workers and Neon: constraints that shaped the code"
description: "Workers/neon-http constraints (subrequest caps, batch-only no interactive transactions, no POSIX filesystem, CPU-bound work) left residue in the code; the 2026-07-30 decision moved everything to AWS ECS + RDS."
tags: [infra, architecture, cloudflare, neon, aws, history]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:25:31Z" }
status: stable
governance: context
code_refs: ["apps/web/src/db/client.ts", "apps/web/src/db/nodeClient.ts", "apps/web/src/server/repositories/homeworks.ts", "Dockerfile.aws", "infra/src/app.ts"]
sources:
  - resource: "issue #67"
  - resource: "issue #163"
  - resource: "issue #157"
  - resource: "issue #416"
  - resource: "PR #458"
  - resource: "PR #459"
  - resource: "PR #461"
  - resource: "issue #455"
---

## History

- 2026-06-02: the initial proposal was Cloudflare Pages/Workers plus R2, Neon plus Drizzle, WorkOS and the Vercel AI SDK, chosen for generous free tiers.
- **2026-07-30 decision (#67): all infra on AWS, provisioned with Pulumi. No Neon, no Cloudflare.** AWS credits make it effectively free. This is settled and not open for re-comparison.
- PR #459 (2026-09-18) moved `apps/web` from Workers to `@hono/node-server` on Node 24, because the OKF knowledge base needs a POSIX directory, a connection pool and background extraction. PR #458 added the ECS Fargate topology. PR #461 removed the remaining Neon usage and simplified the production stack.

## Constraints that left residue in the code

- **neon-http supports `db.batch()` but not interactive transactions.** node-postgres is the mirror image. `runAtomically` feature-detects `db.batch` versus `db.transaction`, and `updateHomework` has a driver-adaptive split. #163 (open, must-complete) deletes the batch branch and standardises on node-postgres transactions. #157 (coverage for the batch path) was closed as wasted effort.
- **Per-invocation subrequest caps** (1000, or 50 on free). Every neon-http statement was a fetch, which shaped job batching (see bugs/overdue-sweep-budget-and-races). The budget constant was removed after the move.
- **`makeDb()` caching:** the review of #458 found it returned the first pool regardless of URL. It now rejects a different URL until the pool is closed.

## Still referencing the old stack

- #455 asks for a stakeholder sandbox on WorkOS plus **Neon**. A review comment says to rewrite it for the AWS staging stack.
- `apps/web/.dev.vars.example` and some docs still use Workers-era naming (inferred from #319 and #457, so check before following them).
- Interim deployments on Cloudflare and Neon may still exist for demos, but they are not the target.
