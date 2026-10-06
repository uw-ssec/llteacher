---
type: Bug
title: "Overdue auto-submit sweep: per-org cap vs per-invocation budget, and abort-on-one-org"
description: "The hourly overdue auto-submit sweep had a per-org cap against Cloudflare's per-invocation subrequest limit, aborted every org on one failure, and raced restarts onto soft-deleted conversations; fixed in PR #432."
tags: [jobs, submissions, cloudflare, reliability, concurrency]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:25:31Z" }
status: stable
governance: context
code_refs: ["apps/web/src/server/jobs/autoSubmitOverdue.ts", "apps/web/src/server/repositories/submissions.ts"]
sources:
  - resource: "issue #414"
  - resource: "issue #416"
  - resource: "issue #417"
  - resource: "PR #413"
  - resource: "PR #432"
  - resource: "PR #458"
  - resource: "issue #442"
---

## Bugs found in multi-agent review of M4 PR4 (#413), fixed in PR #432

- **#414:** the per-org loop had no try/catch around the candidate SELECT. One org's deterministic failure aborted the whole sweep at the same place every hour, skipped every later org and suppressed the run summary. Fix: isolate each org.
- **#416:** `OVERDUE_SUBMISSION_CANDIDATE_LIMIT` capped candidates **per org**, but Cloudflare's limit (1000 subrequests per Worker invocation, 50 on free) is **per invocation**. With neon-http, every SQL statement is one fetch subrequest, so cost was 1 + N orgs + the sum of candidates. Fix: a run-level budget that narrows each org's limit to what remains, with the starting org rotated hourly so the tail is not starved.
- **#417:** `insertAutoSubmission` re-checked nothing at write time. A student's restart racing the sweep could park a submission on a soft-deleted conversation, and the student's later submits would 503 permanently. Fix: a single `INSERT ... SELECT` guarded on `is_deleted`, so the check and the write happen in one statement.

## After the AWS re-platform

PR #458 moved the job to a plain Node process on ECS (and #461 to in-process scheduling). Review of #458 pointed out that the Workers-era `AUTO_SUBMIT_RUN_SUBREQUEST_BUDGET = 900` would keep silently deferring work for no reason. It was removed, and the job now processes the full candidate set in bounded DB batches. #442 (open) notes that the batched candidate query still has no SQL-level per-org row bound.

## Lessons

- Fault-isolate per tenant in batch jobs.
- When the platform changes, remove limits that encoded the old platform's constraints.
- Do check-then-write as one statement (or with a lock) when a user action can race a background job.
