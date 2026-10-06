---
type: Decision
title: "One ECS task serves the student app, instructor console, and API, with stop-before-start replacement"
description: "Production runs exactly one Fargate task (desiredCount 1, min healthy 0%, max 100%) serving /, /admin and /api, accepting brief deploy downtime to keep a single writer for knowledge and extraction state."
tags: [infra, ecs, availability, single-writer]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:32:34Z" }
status: stable
governance: constraint
code_refs: [infra/src/app.ts, infra/src/resources.test.ts, apps/web/src/node/server.ts]
sources:
  - resource: docs/superpowers/specs/2026-09-21-minimal-production-infrastructure-design.md
  - resource: docs/superpowers/plans/2026-09-15-m12-milestone-findings.md
  - resource: docs/superpowers/plans/2026-09-21-infrastructure-implementation-handoff.md
  - resource: docs/superpowers/plans/2026-09-21-pr461-review-disposition.md
  - resource: "PR #461"
---

## Spec proposed
The 2026-09-15 M12 findings chose one full-app service over two independent services, to avoid a second ECR repo, task definition, target group, and an inter-service proxy. The 2026-09-21 minimal-production design added the replacement policy: `minimumHealthyPercent: 0`, `maximumPercent: 100`, desired count one.

## Implemented
`infra/src/app.ts` declares the ECS service with `desiredCount: config.deployApp ? 1 : 0`, `deploymentMinimumHealthyPercent: 0`, and `deploymentMaximumPercent: 100`. An inline comment explains the reason: durable knowledge has "one in-process writer and no cross-task concurrency control". `infra/src/resources.test.ts` locks these three settings together. One ALB target group health-checks `/api/health`.

## Why
- The knowledge base is a local OKF working copy persisted to S3 by a single process, with no distributed locking (see `decisions/knowledge-persistence-s3-manifest`).
- Course-material extraction runs on an in-process queue (see `decisions/in-process-extraction-and-ocr`).
- Two overlapping tasks during a rolling deploy would create two writers.

## Rejected alternatives
- Rolling replacement with overlap.
- Autoscaling or HA.
- Two services (web and admin).
- EFS-backed shared state, which would make multiple writers possible but needs locking design.

## Consequences
- **Every release causes brief downtime.** Migrations run while the old task still serves, and only a successful migration allows replacement.
- Horizontal scaling is explicitly unsupported. `infra/README.md`: "Scaling to multiple app tasks is not supported by this release." Changing desired count, or running a second local process against the same course data, breaks the knowledge persistence invariants.
- Lifting this requires a cross-task concurrency design for knowledge writes and extraction (SQS is named as the first post-release reliability addition).

# Related Concepts
- [The Fargate task runs in public subnets with a public IP and no NAT gateway](nat-free-public-subnet-task.md): Networking of that single task
- [The overdue-submission sweep runs inside the app with a PostgreSQL advisory lock, not as an EventBridge task](in-process-overdue-sweep.md): Background work runs inside the same task
