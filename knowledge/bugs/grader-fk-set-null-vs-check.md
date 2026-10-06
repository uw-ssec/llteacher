---
type: Bug
title: ON DELETE SET NULL conflicted with a CHECK constraint on grades
description: "grades.grader_membership_id ON DELETE SET NULL broke grades_grader_consistency_chk: Postgres runs SET NULL as an UPDATE, the CHECK rejects it, so deleting a grader membership failed; switched to RESTRICT."
tags: [database, schema, postgres, grading]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:25:31Z" }
status: stable
governance: context
code_refs: ["apps/web/src/db/schema/runtime.ts", "apps/web/src/db/migrations"]
sources:
  - resource: "PR #127"
  - resource: "issue #129"
  - resource: "issue #133"
---

## Root cause (#129, found in review of PR #127)

`grades` has a CHECK (`grades_grader_consistency_chk`) requiring a human-graded grade to carry a `grader_membership_id`. The FK on that column was `ON DELETE SET NULL`. Postgres carries out a referential SET NULL as an **UPDATE** on the child row, and CHECK constraints fire on that UPDATE. Deleting a grader's course membership therefore tried to null the column on every human-graded grade. The CHECK rejected it and the delete aborted, with an error that points at the CHECK rather than the FK.

## Fix

The FK became `ON DELETE RESTRICT`. A membership that graded work cannot be deleted. It is dropped instead (`dropped_at` / `dropped_reason`). The fix was tested against a live pgvector Postgres: the delete is blocked, the grade survives, and the AI-graded path and both CHECK polarities still work.

## Generalisation

- Do not pair `SET NULL` with a CHECK or NOT NULL condition that can require the column. The combination is a latent, contradictory constraint that only shows up on delete.
- The same review pass (#133) moved `grades.submission_id` and both `llm_call_logs` FKs from CASCADE to RESTRICT. Deleting a user could otherwise have cascaded through conversations and submissions and silently erased a FERPA education record. Grades and LLM logs are now protected from accidental cascades through user, conversation and submission deletion. Organization deletion behaves differently (see bugs/org-delete-cascade-order).
- Live-database verification matters. Mocked tests with no-op WHERE clauses pinned neither behaviour (#152).
