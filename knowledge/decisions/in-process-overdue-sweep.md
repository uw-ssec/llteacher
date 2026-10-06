---
type: Decision
title: "The overdue-submission sweep runs inside the app with a PostgreSQL advisory lock, not as an EventBridge task"
description: "The 09-15 M12 design scheduled the hourly auto-submit sweep as an EventBridge-launched ECS task; the 09-21 design moved it in-process (startup + hourly) behind pg_try_advisory_lock, removing the scheduler infra."
tags: [infra, jobs, scheduling, postgres]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:32:34Z" }
status: stable
governance: constraint
code_refs: [apps/web/src/node/overdue-scheduler.ts, apps/web/src/node/run-overdue-job.ts, apps/web/src/server/jobs/autoSubmitOverdue.ts, apps/web/src/db/client.ts]
sources:
  - resource: docs/superpowers/plans/2026-09-15-m12-local-aws-design.md
  - resource: docs/superpowers/plans/2026-09-15-m12-milestone-findings.md
  - resource: docs/superpowers/specs/2026-09-21-minimal-production-infrastructure-design.md
  - resource: commit 0db13d3
  - resource: docs/superpowers/plans/2026-08-05-m3-homeworks-submissions-parity.md
---

## Spec proposed
- **M3 (decision 4):** auto-submit-overdue was deferred. No Cloudflare Cron Trigger was added, and an overdue in-progress section reports `in_progress_overdue` (Django parity).
- **M12 local design (2026-09-15):** one EventBridge schedule launches a short-lived ECS task running the overdue command from the same image. The M12 findings recorded this as "one minimal EventBridge job".
- **Minimal-production design (2026-09-21):** the sweep moves into the application. It runs once after startup and hourly after that, under a PostgreSQL advisory lock that keeps its existing idempotency, so "a future scale-out cannot submit work twice".

## Implemented
The 09-21 version (commit `0db13d3`):
- `apps/web/src/node/overdue-scheduler.ts` runs the job on startup and every `HOUR_MS` with `setInterval`, and shuts down cleanly. Node shutdown is bounded to 25 s per the PR #461 disposition.
- `apps/web/src/db/client.ts` provides a session-scoped `pg_try_advisory_lock` / `pg_advisory_unlock` helper.
- The job logic lives in `server/jobs/autoSubmitOverdue.ts`. The #437 fix batches the candidate select, so the per-run budget no longer caps coverage at about 899 orgs.
- `infra/src/` contains no EventBridge, SQS, scheduler role, or scheduled task definition.
- `node/run-overdue-job.ts` and the root `node:run-overdue-job` script still exist as a manual or one-shot entry point.

## Why
Removing the EventBridge rule, target, scheduler role and policy, scheduled task definition, log group, SQS DLQ, queue policy, and a DLQ alarm the design calls "ineffective" simplifies the stack and its IAM surface.

## Rejected alternatives
EventBridge-scheduled ECS task; Cloudflare Cron Trigger; a separate worker service.

## Consequences
The advisory lock is the safety net if more than one process ever runs. Keep the job idempotent and keep the lock key constant (named per the PR #461 disposition).

# Related Concepts
- [In-process background work and shutdown lifecycle](../architecture/background-jobs-and-lifecycle.md): How in-process jobs and shutdown are implemented
- [Overdue auto-submit sweep: per-org cap vs per-invocation budget, and abort-on-one-org](../bugs/overdue-sweep-budget-and-races.md): Bugs found in the sweep
