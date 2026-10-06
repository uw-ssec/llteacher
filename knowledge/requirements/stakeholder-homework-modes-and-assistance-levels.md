---
type: Requirement
title: "Stakeholder requirement: tutor and homework modes, code as bonus, leveled prompts"
description: "PIs need two core modes (open tutor sessions with course context; professor-defined homework worked through in sections), with code assignments as a bonus mode, plus professor-set prompts and assistance levels."
tags: [stakeholder, homeworks, tutor, prompts, product]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:25:31Z" }
status: stable
governance: context
code_refs: ["apps/web/src/server/repositories/homeworks.ts", "apps/web/src/client/hooks/useWebR.ts"]
sources:
  - resource: "issue #69"
  - resource: "issue #71"
  - resource: "issue #72"
  - resource: "PR #154"
  - resource: "PR #317"
  - resource: "PR #366"
  - resource: "milestone M13"
---

## Stated needs (transcript 2026-06-02, SSEC requirements session)

Three usage modes came out of the four projects:

1. **Tutor mode.** No specific assignment. The tutor has the student's history and course context ("I'm reading my textbook, help me understand it"). It shows up for students as **sessions**. Economics was primarily here.
2. **Homework/assignment mode.** The professor pre-defines the assignment and the student works through it in **sections** with the tutor. Statistics and nursing use this. Tutor plus homework covers three of the four projects.
3. **Code mode.** Coding assignments with in-browser editing and tutoring, for engineering. Explicitly a **bonus** feature, still under discussion.

Professors should be able to **create a class and pick which modes it uses**, set system prompts, attach materials for grounding, and define assignments with **assistance levels** (the original LLTeacher uses level 1–4 style prompt handling).

## Where it landed

- Tutor conversations (the tutor rail) and section conversations with start/restart lifecycle and section-aware prompts: M4 (PRs #212, #317).
- Homework and section CRUD, non-interactive sections, hide/expiry and progress: M3 (PRs #154, #173).
- R code execution in the browser with WebR: PR #366. This partly meets code mode for R-based courses.
- Hint budgets with deterministic hint requests: PR #366 (#80).
- **Not yet built:** class setup with mode composition and assistance-level presets (#69), the prompt-template engine with four-level scoped resolution (#71), course self-service (#68), and homework type templates (#329). All are M13 or unmilestoned.

## Guidance

When designing course setup, model modes as per-class composition rather than per-org settings, and keep prompt scoping hierarchical (org, course, homework, section).
