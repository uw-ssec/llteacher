---
type: Decision
title: Homework status is derived on read from publishedAt and releasedAt
description: M3 added nullable publishedAt/releasedAt to homeworks and derives draft/scheduled/active/past_due at read time instead of storing status or running a scheduled transition job.
tags: [homeworks, data-model, parity]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:32:35Z" }
status: stable
governance: context
code_refs: [apps/web/src/server/repositories/homeworks.ts, apps/web/src/server/routes/homeworks.ts, apps/web/src/db/schema/content.ts, apps/admin/src/client/views]
sources:
  - resource: docs/superpowers/plans/2026-08-05-m3-homeworks-submissions-parity.md
  - resource: "PR #154"
  - resource: "PR #173"
  - resource: commit eb9f8a4
  - resource: commit f052602
---

## Spec proposed / implemented (M3 decision 5)
`homeworks` gained two nullable timestamps, `publishedAt` and `releasedAt`. Status is computed when a homework is read:
- no `publishedAt` → `draft`;
- `releasedAt` in the future → `scheduled`;
- released and before `dueDate` → `active`;
- released and past `dueDate` → `past_due`.

The fixture-era `archived` value has no producer. The derivation marks it unreachable on purpose rather than quietly dropping it. Draft/publish (#94) was built together with CRUD (#19), ahead of the student list and dashboard, so those were built against the final homework contract.

Related M3 decisions that shaped the code:
- **Route shape:** single-homework routes nest under `/api/courses/:courseId/homeworks/:homeworkId` (and `/publish`) so the existing guards work unchanged (decision 2).
- **Section reordering** uses dependency-ordered updates with cycle-breaking scratch bumps against the non-deferrable `sections_homework_order_uq` index, with no schema change (decision 7).
- **Section deletes** still cascade to conversations, messages, and submissions (decision 3, kept from M2).
- **Encrypted-column hazard:** Drizzle relational `with:` joins serialize `bytea` through JSON and silently corrupt `encryptedText` columns. Flat `innerJoin` selects are used wherever encrypted user columns are read (decision 10). This invariant matters for any new roster query.
- **Course selection** in the admin console was a stopgap: `GET /api/profile` returns the caller's courses and the console uses `courses[0]` until #70's switcher exists (decision 8).
- Homework duplication and rollover belong to M13 (#92).

Follow-ups in PR #173 (#164-#166) added hide/expiry release gating (`server/releaseGate.test.ts`), non-interactive sections, and progress widgets.

## Why
A derived status cannot go stale and needs no scheduler. Cloudflare had no cron at the time, and later the stack deliberately has no EventBridge.

## Rejected alternatives
- A stored status column with a transition job.
- A deferrable unique constraint for reordering.

## Consequences
Status logic must stay identical across student and admin read paths. Overdue auto-submission is a separate job (see `decisions/in-process-overdue-sweep`).

# Related Concepts
- [Stakeholder requirement: tutor and homework modes, code as bonus, leveled prompts](../requirements/stakeholder-homework-modes-and-assistance-levels.md): Homework modes stakeholders asked for
- [Data model and shared-schema multi-tenancy](../architecture/data-model-multi-tenancy.md): Status is derived, not stored
