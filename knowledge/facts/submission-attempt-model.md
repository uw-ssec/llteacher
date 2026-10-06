---
type: Plan
title: "Submission attempt model: one mutable row now, attempt table deferred"
description: "Decision: one submission per (student, section), restart voids it, graded sections cannot restart (PR #247); an attempt table with attempt_number and grades per attempt was deferred, not rejected (#250)."
tags: [submissions, grading, data-model, decision]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:25:31Z" }
status: stable
governance: hold
code_refs: ["apps/web/src/server/repositories/submissions.ts", "apps/web/src/db/schema/runtime.ts", "docs/superpowers/specs"]
sources:
  - resource: "discussion #249"
  - resource: "PR #247"
  - resource: "issue #250"
  - resource: "issue #128"
  - resource: "issue #258"
  - resource: "issue #27"
---

## Current model (PR #247, closing #128 and #27)

- `submissions` used to carry only `conversation_id`, so "one submission per student per section" could not be expressed as a constraint. Soft-delete-and-recreate cycles could pile up rows.
- Now: `conversations UNIQUE (id, owner_user_id, section_id)`, `submissions FK (conversation_id, user_id, section_id) REFERENCES conversations (id, owner_user_id, section_id)`, and `submissions UNIQUE (user_id, section_id)`. The **composite FK** makes the denormalised columns trustworthy rather than maintained by convention.
- **Restart voids the submission.** The student returns to not-submitted and resubmits the new conversation. **A graded section cannot be restarted.**
- Rejected alternatives: *supersede*, which would report "submitted" for a conversation containing no work and attach grades to transcripts that no longer exist, and *lock*, which would make an undesigned instructor-reopen workflow a hard dependency.
- Spec: `docs/superpowers/specs/2026-08-11-submission-uniqueness-design.md`.

## Deferred alternative (discussion #249, issue #250)

An attempt table: drop `UNIQUE (conversation_id)`, turn `UNIQUE (user_id, section_id)` into a partial index over live attempts, add `attempt_number`, and point `grades.submission_id` at a specific attempt. Half of the migration (denormalised `user_id`/`section_id` plus the composite FK) has already landed. The discussion's argument that this should happen early, "while there's little real data", was **postponed, not refuted**. #250 exists so the deferral stays visible instead of hardening into the status quo.

## Consequences while deferred

- A grade can describe replaced work after resubmission (#258, see bugs/grade-stale-after-resubmission).
- Restarted attempts survive only as soft-deleted rows that every read path filters out. Instructors see only `hasDeletedConversation`.

## When to revisit

Before real student data piles up in production. That means before or during the Django ETL (#64), and before analytics (M8) or regrade workflows depend on submissions.
