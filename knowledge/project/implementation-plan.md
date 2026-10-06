---
type: Plan
title: "Implementation plan: the milestone sequence as it actually ran (M1 to M13)"
description: "How the Django-to-TypeScript port actually executed: June master plans, the July bootstrap, M1-M5 parity, then knowledge (M7), Canvas (M11) and AWS infrastructure (M12), with what landed and what is still open."
tags: [plan, milestones, roadmap, history]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:32:34Z" }
status: stable
governance: context
code_refs: [docs/superpowers/plans, docs/superpowers/specs, apps/web, apps/admin, infra, evals]
sources:
  - resource: docs/superpowers/plans/2026-06-01-llteacher-fullstack-port.md
  - resource: docs/superpowers/plans/2026-06-01-llteacher-platform-generalization.md
  - resource: docs/superpowers/plans/2026-07-31-m1-auth-workos.md
  - resource: docs/superpowers/plans/2026-08-03-m2-runtime-persistence.md
  - resource: docs/superpowers/plans/2026-08-05-m3-homeworks-submissions-parity.md
  - resource: docs/superpowers/plans/2026-08-07-m4-conversations-chat-parity.md
  - resource: docs/superpowers/plans/2026-09-10-m11-canvas-integration.md
  - resource: docs/superpowers/plans/2026-09-21-m12-infrastructure-milestone-audit.md
  - resource: GitHub milestones uw-ssec/llteacher (checked 2026-10-06)
---

Milestones are GitHub milestones on `uw-ssec/llteacher`. Plans live in `docs/superpowers/plans/`. Each milestone was planned separately, executed by subagents phase by phase with review gates, and audited after closure.

| Milestone | Goal and plan | What landed |
|---|---|---|
| Foundations (Jun 1) | Two master plans: Django generalization vs TS full-stack port | The port won. The Django phases never ran. |
| Bootstrap (Jul 30) | Port phase 0: monorepo scaffold | PR #106 `a7cf2c3`: web chat, admin shell, schema (identity/content), docs. TypeScript was then upgraded to 7. |
| **M1** Auth & Identity (closed) | `2026-07-31-m1-auth-workos.md` | PR #110: WorkOS AuthKit, sealed cookie, encrypted provisioning, domain allowlist, role guards, profile. Followed by TA capabilities (#172/PR #209). |
| **M2** Runtime data layer | `2026-08-03-m2-runtime-persistence.md` | PR #127: conversations/messages/submissions/grades/citations/llm_call_logs/student_profiles/audit_events, branded scopes, TS seed. 24 recorded decisions. |
| **M3** Homeworks parity | `…m3-homeworks-submissions-parity.md`, plus `submission-uniqueness` spec and plan | PRs #154/#173: CRUD with section diffing, derived status, student progress, submit, participation matrix. PR #247: one submission per (student, section). |
| **M4** Conversations, chat, R | `…m4-conversations-chat-parity.md` (5 PRs) | #212 persisted tutor chats, #317 section-aware prompting and config resolution, #366 WebR and transcripts, #413 reliability and data integrity, #440 UX/a11y and eval harness (`evals/`). About 151 issues closed. |
| **M5** Admin console & LLM config | (no standalone plan doc) | `ac34e17` (#363): live instructor console, LLM-config CRUD, roster, grading, export. |
| **M7** RAG & course materials | Specs from 09-09 → 09-15 → 09-17 | 09-09 Postgres bundle and collections (PRs #445/#446), replaced by the okf-served bundle (PR #459). Extraction plus OCR, citations, search-first console, knowledge toggle. No embeddings. |
| **M11** Canvas (closed) | `2026-09-10-m11-canvas-integration.md` | PR #457: instructor token, roster sync. LTI deferred. |
| **M12** Infra, migration, cutover | Local AWS design and plans (09-15), minimal-production design and plan (09-21), S3 backend (09-22), secrets (09-29) | PR #458 Node runtime plus Floci. PR #461 minimal us-west-2 stack and S3 knowledge persistence. PRs #463-#473 account bootstrap, S3 backend, GitHub secrets, operator domain, service-linked roles. |
| M13 Course & class mgmt | — | PR #462 chat feature fixes. Course CRUD and rollover (#68, #92) still open. |

## Still open (as of 2026-10-06)
- M12: 13 open issues, including SQLite→Postgres ETL from Sara's live Django deployment, DNS cutover, Django/Coolify retirement, DR drills, observability, and full Playwright CI. The minimal stack is described as "not completion of M12".
- M9 FERPA (11 open), M8 analytics, M6 generative UI expansion, M10 branding/a11y.
- First real production release: the bootstrap scripts are merged. Whether a tagged release has run against real AWS is not recorded in the repo (unknown).

# Related Concepts
- [Rewrite in TypeScript instead of extending the Django app](../decisions/typescript-rewrite-over-django-extension.md): The plan starts from the decision to rewrite in TypeScript
