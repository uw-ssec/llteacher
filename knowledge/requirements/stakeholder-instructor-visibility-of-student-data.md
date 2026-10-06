---
type: Requirement
title: "Stakeholder requirement (unresolved): aggregate vs individual student data for instructors"
description: "The nursing-informatics PI asked for aggregate-only performance views, conflicting with Django-parity transcript viewing and grading; decision #78 is open and gates analytics and per-student drill-ins."
tags: [stakeholder, privacy, ferpa, analytics, decision]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:25:31Z" }
status: stable
governance: hold
code_refs: ["docs/notes"]
sources:
  - resource: "issue #78"
  - resource: "issue #29"
  - resource: "issue #47"
  - resource: "issue #53"
  - resource: "PR #366"
  - resource: "milestone M9"
---

## Conflict (#78)

- **Django parity baseline:** teachers read full individual conversation transcripts. Already shipped in the TS stack: the instructor transcript viewer (#29, PR #366) and the submissions dashboard drill-in. Grading reads individual answers.
- **2026-07-28 meeting note, attributed to the nursing-informatics PI:** instructors should see **aggregate performance only, not individual student answers**, because of concerns about individual data.

These may be reconcilable. For example, transcripts could stay visible for grading inside a student's own submission context, while quiz, performance and engagement **analytics** stay aggregate. But #78 insists this must be **decided, not assumed**.

## Required outputs (from #78)

- Confirm the policy with the PIs (at least stats and nursing informatics) and record their answers.
- Build a visibility matrix: surface (transcripts, submission status, quiz answers, engagement signals, at-risk flags, grades) × role (instructor, TA, org admin) × granularity (individual or aggregate). Note whether the policy varies per course or org.
- Record the decision in compliance docs (feeding the FERPA data-flow doc #53) and update acceptance criteria on #29, #47 (per-student drill-ins), grading, and adaptive quizzes (#76).

## Status

Open (M9). Until it is resolved, treat any new per-student surface, especially M8 analytics and at-risk flags, as needing this decision first. Transcript reads already write a FERPA audit event (PR #366). Policy may need to be configurable per course or org (inferred).
