---
type: Requirement
title: "Stakeholder requirement: help instructors see where students have knowledge gaps"
description: "PIs want quiz and interaction data turned into per-topic knowledge-gap signals so instructors (or the tutor) can target follow-up work and adaptive quizzes; tracked in M8 and constrained by #78."
tags: [stakeholder, analytics, quizzes, student-profiles]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:25:31Z" }
status: stable
governance: context
code_refs: ["apps/web/src/db/schema/runtime.ts"]
sources:
  - resource: "issue #46"
  - resource: "issue #47"
  - resource: "issue #49"
  - resource: "issue #76"
  - resource: "issue #36"
  - resource: "issue #78"
  - resource: "milestone M8"
---

## Stated need (transcript 2026-07-28)

Two goals were recorded from the PI conversations:

1. Base the tutor on the assignments and material the instructor uploads (see requirements/stakeholder-course-grounded-tutoring).
2. **As a teacher, understand from students' quizzes where each student may have a gap** in the coursework, so the instructor can tailor work for them, or so the tutor can generate more interactive quizzes that target the gap.

The engineering PI's tutor also wants a per-student profile that persists across sessions (SSEC context notes).

## Where it is tracked (all open, M8 / M6)

- #46: engagement metrics and mastery signals stored in `student_profiles` (the table exists from M2; `summary` and `mastery_signals` are planned for encryption as accommodations data, #137).
- #47: instructor analytics dashboard. #48: org-level usage and cost reporting.
- #76: adaptive quiz generation targeting knowledge gaps.
- #36: multiple-choice knowledge-check generative-UI tool with response capture (M6).
- #169: paste and rapid-text-growth integrity telemetry.
- #45: LLM call logging. `llm_call_logs` exists but still had no writer as of #335.

## Constraint

Whether gap signals are shown **per student or only in aggregate** depends on the open privacy decision #78. The nursing-informatics PI asked for aggregate only. Design dashboards so granularity can be switched by policy (inferred).

## Status

Not started. M8 has 10 open and 0 closed issues.
