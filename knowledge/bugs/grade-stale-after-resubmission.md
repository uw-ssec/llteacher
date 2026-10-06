---
type: Bug
title: Resubmitting after grading leaves the grade describing replaced work
description: "submissions is one mutable row per conversation; resubmit only overwrites submittedAt, so an existing grade keeps pointing at the row with no staleness flag or grader notice. Open (#258), tied to attempt-model decision #250."
tags: [grading, submissions, data-integrity, ferpa]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:25:31Z" }
status: stable
governance: hold
code_refs: ["apps/web/src/server/repositories/submissions.ts", "apps/web/src/db/schema/runtime.ts"]
sources:
  - resource: "issue #258"
  - resource: "discussion #249"
  - resource: "issue #250"
  - resource: "PR #247"
  - resource: "issue #415"
---

## Status: open (#258)

## Mechanism

- `submitSection` (`repositories/submissions.ts`) checks org scope, `isDeleted`, `kind = 'section'`, ownership, hidden homework and `isTeacherTest`. **It never queries `grades`**, so resubmission after grading is allowed, matching Canvas-style multiple submissions.
- On resubmit it changes the row in place: `update(submissions).set({ submittedAt: new Date() })` on the same `submissions.id`.
- `grades.submissionId` still points at that row. `grades` has `score`, `rubric`, `feedback` and `gradedAt`, but no `supersededAt`, no staleness flag and no snapshot of what was graded. The grader is not told. The dashboard shows "submitted" next to a grade as if the two agreed.
- Because there is exactly one submission row per (student, section), the question "which attempt does this grade describe?" cannot be answered from the data.

A sibling bug that was fixed: #415. The resubmission path also set only `submittedAt`, so work resubmitted after the overdue auto-submit sweep stayed labelled auto-submitted (fixed in PR #432).

## Why it is a hold

The fix depends on the attempt-model decision (#250, see facts/submission-attempt-model). Under the current single-row model the minimum fix is a staleness marker on `grades` set at resubmit time, plus a dashboard indicator. Under an attempt table, grades would point at a specific attempt.

## Guidance

Do not add features that read "graded" as final until #258 or #250 is settled. Grades are education records, so any change needs an audit trail.
