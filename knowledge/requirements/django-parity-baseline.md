---
type: Requirement
title: "The TS port must reach Django feature parity first, and deviations must be written down"
description: "Milestones M1-M5 target parity with the legacy Django app (accounts, homeworks, conversations, LLM config, R execution); behavior changes from Django must be recorded as resolved design decisions, not drift."
tags: [parity, django, process, port]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:25:30Z" }
status: stable
governance: context
code_refs: ["apps/accounts", "apps/homeworks", "apps/conversations", "apps/llm", "src/llteacher", "apps/web/src/lib/services/DomainAllowlistService.ts", "apps/web/scripts/seed.ts"]
sources:
  - resource: "docs/superpowers/plans/2026-06-01-llteacher-fullstack-port.md"
  - resource: "docs/superpowers/plans/2026-08-05-m3-homeworks-submissions-parity.md"
  - resource: "docs/superpowers/plans/2026-08-07-m4-conversations-chat-parity.md"
  - resource: "docs/superpowers/plans/2026-08-03-m2-runtime-persistence.md"
  - resource: "legacy_documentation/00_executive_summary.md"
---

## The requirement
The port plan's goal was "feature parity with the current Django app first, then layer multi-tenancy / Canvas LTI / RAG on top". M1-M5 are named as parity milestones: Auth & Identity, Runtime Data Layer, Homeworks & Submissions Parity, Conversations/Chat/R Execution Parity, and Admin Console & LLM Config Parity.

## Parity points carried into code (examples)
- Email-domain allowlist (`uw.edu`) is a "parity port of Django's ALLOWED_EMAIL_DOMAINS" (`DomainAllowlistService`).
- One submission per student per section, matching Django's `Submission.clean()`. It is now a DB constraint (see `decisions/submission-restart-voids`).
- `in_progress_overdue` section status for overdue in-progress work.
- Only students self-register. Instructors are provisioned (Django `ba3fe52`; TS: super-admin instructor provisioning).
- The seed script mirrors `populate_test_database.py` (2 instructors, 3 students, 2 homeworks), with deterministic `(i % 5) < 3` submission rates.
- Client-side R via WebR, and section-aware tutor prompts.

## Deliberate deviations (recorded, not drift)
- Message parts jsonb instead of `message_type` (M2 d2).
- Teacher/Student profiles dropped for course memberships.
- A third seed section, to match epic wording over Django (M2 d13).
- The AI message is saved on stream completion, not per token as Django did (port phase 3/6 question, inferred implemented).
- Restart voids the submission. Django never defined resubmission.

## Process rule
The M3 post-closure audit compared shipped code against every checkbox in the original GitHub issue bodies, not only against task briefs, and found 7 unbuilt requirements. Parity reviews should check against the source issue and the Django behavior. Record deviations in the plan's "Resolved Design Decisions" and PR bodies.

## Status
Parity milestones are mostly closed in practice. M1 is closed. M2-M5 still show 0-1 open issues on GitHub as of 2026-10-06. Data migration from the live Django SQLite deployment and Django retirement are **not done**. The legacy code still ships in `apps/{accounts,conversations,homeworks,llm}`, `src/`, and `services/`.
