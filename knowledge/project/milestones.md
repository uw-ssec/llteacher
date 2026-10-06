---
type: Reference
title: Milestones M1-M13 and what each delivered
description: "All 13 GitHub milestones (created 2026-07-30) with state, open/closed counts as of 2026-10-06, due dates, and the PRs that delivered them."
tags: [project, milestones, roadmap]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:32:34Z" }
status: stable
governance: context
code_refs: [docs/superpowers/plans, docs/superpowers/specs]
sources:
  - resource: milestone M1
  - resource: milestone M2
  - resource: milestone M3
  - resource: milestone M4
  - resource: milestone M5
  - resource: milestone M6
  - resource: milestone M7
  - resource: milestone M8
  - resource: milestone M9
  - resource: milestone M10
  - resource: milestone M11
  - resource: milestone M12
  - resource: milestone M13
  - resource: "issue #67"
---

All milestones were created on 2026-07-30 from roadmap issue #67. Counts are open/closed issues as of 2026-10-06. Several milestones still show as "open" with zero or one leftover issue. Their delivery PRs have merged.

| Milestone | State | Open/closed | Due | Delivered by |
|---|---|---|---|---|
| M1 Auth & Identity (WorkOS) | closed 2026-09-22 | 0/20 | – | PR #110 (AuthKit session, encrypted provisioning, uw.edu allowlist, role guards, profile), PR #127 (WorkOS webhooks #95), PR #209 (TA grader tier) |
| M2 Runtime Data Layer & Persistence | open | 0/9 | – | PR #127: conversations, messages, submissions, grades, citations, llm_call_logs, student_profiles, audit_events, org-scoped repositories, seed |
| M3 Homeworks & Submissions Parity | open | 1/23 | – | PRs #154, #173, #247; #165 (self-assessment widgets) remains |
| M4 Conversations, Chat & R Execution | open | 1/151 | – | PR #212 (PR1), #317 (PR2), #366 (PR3: WebR + transcript viewer), #413/#432 (PR4), #440 (PR5, closed epic #30); #442 remains |
| M5 Admin Console & LLM Config Parity | open | 1/34 | – | PR #363 (live console, roster, grading, export); #367 Org Admin role remains |
| M6 Generative UI Expansion | open | 5/0 | – | not started (#35–#39) |
| M7 RAG & Course Materials | open | 6/0 | 2026-09-17 (past) | issues untouched, but the knowledge base shipped another way: OKF bundle via PRs #445, #459 (inferred overlap, so issues #40–#44 need re-scoping) |
| M8 Data Analytics & Telemetry | open | 10/0 | – | not started |
| M9 FERPA Compliance | open | 11/4 | 2026-09-30 (past) | audit-event wiring (#147) landed in PR #127; epic #54 open |
| M10 UW Branding & Accessibility | open | 5/1 | – | mostly open |
| M11 Canvas Integration | closed 2026-09-22 | 0/3 | 2026-09-17 | PR #457 (instructor token + roster sync), PR #462 (import from Students tab); LTI #58–#60 deferred outside the milestone |
| M12 Infra, Migration & Cutover | open | 13/6 | 2026-09-17 (past) | PRs #458, #461, #463–#473 (AWS/Pulumi foundation and first production release); ETL #64, Django retirement #65, E2E #83 and DR #84 open |
| M13 Course & Class Management | open | 9/1 | – | not started apart from course-membership provisioning via PR #464 |

Build order per #67: M1, M2, M13, then M3, M4, M5. In practice M13 slipped and M3–M5 were built first, which is why there is still no course-creation path (see facts/authority-and-provisioning-gaps). The label `must-complete: fall-quarter` marks the 19 open issues (M7, M12) that were scoped as the fall-pilot minimum.

# Related Concepts
- [Implementation plan: the milestone sequence as it actually ran (M1 to M13)](implementation-plan.md): The plan documents behind each milestone, as executed
