---
type: Decision
title: Restarting a submitted section voids its submission; one submission per student per section
description: "Issue #128 closed the soft-delete loophole: submissions gained user_id/section_id tied to the conversation by composite FK with UNIQUE(user_id, section_id); restart deletes the submission; graded sections cannot restart."
tags: [data-model, submissions, homeworks, parity]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:32:35Z" }
status: stable
governance: constraint
code_refs: [apps/web/src/db/schema/runtime.ts, apps/web/src/server/repositories/submissions.ts, apps/web/src/server/repositories/conversations.ts, apps/web/src/db/migrations/0021_submission_section_uniqueness.sql, apps/web/src/server/repositories/atomic.ts]
sources:
  - resource: docs/superpowers/specs/2026-08-11-submission-uniqueness-design.md
  - resource: docs/superpowers/plans/2026-08-11-submission-uniqueness.md
  - resource: docs/superpowers/plans/2026-08-03-m2-runtime-persistence.md
  - resource: "PR #247"
  - resource: commit e3940c1
---

## Spec proposed
M2 assumed that `UNIQUE(submissions.conversation_id)` plus one *active* conversation per (user, section) carried over Django's `Submission.clean()` guarantee. It did not. Soft-delete conversation A, then submit conversation B, and two submissions exist. M2 deferred the fix pending a product decision. The 2026-08-11 spec decided that **restart voids the submission**.

## Implemented
- Migration `0021_submission_section_uniqueness.sql` (PR #247) added NOT NULL `submissions.user_id` and `section_id`, `conversations UNIQUE(id, owner_user_id, section_id)`, a composite FK from submissions to that triple, and `UNIQUE(user_id, section_id)` (`submissions_user_section_uq` in `runtime.ts`).
- The composite FK also makes it impossible to submit a tutor conversation, because `section_id` is NULL there.
- `restartSectionConversation` checks ownership. It throws `SubmissionGradedError` (409) if a grade exists, then atomically soft-deletes the conversation and deletes the submission so the caller can audit `submission.voided`.
- `softDeleteConversation` refuses a submitted section conversation and names the restart function in its error (`conversations.ts`).
- The `runAtomically` helper in `repositories/atomic.ts` came out of this work.

## Why
`grades.submission_id` is `ON DELETE RESTRICT`, so the database already refuses to void a graded submission. The application check turns that into a clear 409.

## Rejected alternatives
- **Supersede.** The dashboard would show "submitted" for an empty conversation.
- **Lock.** It would need an instructor reopen workflow that does not exist.

## Consequences / open
- No attempt history survives a restart. Discussion #249 argues for an append-only attempts table (work item #250). That argument was deferred, not answered.
- A graded section can still be *resubmitted*, which leaves the grade stale (#258).
- `apps/web/ARCHITECTURE.md` documents the rule as "Section Submissions Are One Per (Student, Section)", and the M2 docs mark it as provisional.

# Related Concepts
- [Submission attempt model: one mutable row now, attempt table deferred](../facts/submission-attempt-model.md): The attempt model this decision leads to
- [Resubmitting after grading leaves the grade describing replaced work](../bugs/grade-stale-after-resubmission.md): A grading bug from resubmission
- [ON DELETE SET NULL conflicted with a CHECK constraint on grades](../bugs/grader-fk-set-null-vs-check.md): Grade constraints interacting with deletes
