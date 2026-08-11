# Submission uniqueness and restart semantics (#128)

Status: approved 2026-08-11
Issue: [#128](https://github.com/uw-ssec/llteacher/issues/128)
Coordinates with: #22 (resubmit-in-place, shipped), #27 (delete-and-restart, not built), #75 (grading, not built)

## Problem

M2 shipped two constraints that look like they bound submissions per section but do not:

- `submissions.conversation_id` is `UNIQUE` — one submission per conversation.
- `conversations_owner_section_active_uq` is a partial unique index on
  `(owner_user_id, section_id) WHERE kind = 'section' AND is_deleted = false` —
  one *active* conversation per student per section.

Neither bounds submissions per `(student, section)` across time. The reproduction
recorded on #128: submit conversation A, soft-delete A, create conversation B for
the same section (permitted — A is no longer active), submit B. Two `submissions`
rows now exist for one section.

The root cause is that the constraint is not expressible on the current schema.
`submissions` carries only `conversation_id` and `organization_id`; it has no
column naming the student or the section, so no unique index over that pair can
be written.

#22 states "one submission per student per section enforced (DB unique from M2
schema)". That is half true. Note that the shipped `submitSection` does not use
the `onConflictDoUpdate` upsert #22's own text describes — it reads via
`getSubmissionByConversation` and then updates or inserts. Either way the effect
is the same: the lookup is keyed on `conversation_id`, so it matches only when
the *same* conversation is submitted twice. Once a different conversation exists
for the section, nothing matches and a second row is inserted.

## Decision

**Restart voids the submission.** When a student restarts a section they have
already submitted, the existing submission is deleted and they return to a
not-submitted state; they re-submit the new conversation when they are done.

Rejected alternatives:

- **Supersede** (re-point the submission at the new conversation, keep the
  original `submitted_at`). Rejected because the instructor dashboard would
  report "submitted" for a conversation with no work in it, and any grade would
  attach to a transcript that no longer exists.
- **Lock** (no restart once submitted). Rejected because it makes an
  instructor-side reopen workflow a hard dependency of the restart feature, and
  no such workflow is designed or scheduled.

A section that has been **graded** cannot be restarted at all. This is not a
policy bolted on top: `grades.submission_id` is a `RESTRICT` foreign key, so
deleting a graded submission is refused by Postgres. The application check exists
to turn that into a 409 with a useful message rather than a driver error.

### Accepted scope of this decision

Voiding deletes the `submissions` row, so no attempt history survives. This
was accepted deliberately in order to ship #27's lifecycle, and is tracked for
revisiting in [#250](https://github.com/uw-ssec/llteacher/issues/250) rather
than treated as final. #250 also owns the student-facing requirement that
follows from it: a restart confirmation must state that the previous
submission is discarded, since a student who reads "start over" as "add
another attempt" would lose work believing the opposite.

## Data model

Add `user_id` and `section_id` to `submissions`, both `NOT NULL`, and three
constraints:

```
conversations   UNIQUE (id, owner_user_id, section_id)
submissions     FOREIGN KEY (conversation_id, user_id, section_id)
                  REFERENCES conversations (id, owner_user_id, section_id)
submissions     UNIQUE (user_id, section_id)
```

The composite foreign key is what makes the denormalized columns trustworthy.
Without it, `user_id`/`section_id` would be convention-maintained — correct only
as long as every writer remembers to copy them from the conversation — and the
unique index would be enforcing a pair that could drift from reality. With it,
Postgres rejects any submission whose `(user_id, section_id)` does not match its
own conversation, so `UNIQUE (user_id, section_id)` means what it says.

Two properties fall out of the same constraint:

1. A submission can never reference a tutor conversation. `submissions.section_id`
   is `NOT NULL`; a tutor conversation's `section_id` is `NULL`; a `NOT NULL`
   value never matches `NULL`. The `kind = 'section'` check in `createSubmission`
   becomes a friendly error rather than the only thing preventing the row.
2. The existing `UNIQUE (conversation_id)` is retained, so the 1:1 relationship
   with a conversation still holds.

## Repository layer

New function, `restartSectionConversation(db, scope, conversationId, requesterId)`:

1. Verify the conversation exists in scope, is `kind = 'section'`, is not already
   soft-deleted, and is owned by `requesterId`. Reuses the check shape
   `submitSection` already uses, including its deliberate split between
   "not found or not accessible" and "not owned by requester" so the route layer
   can decide what to leak.
2. If a grade references the submission, throw `SubmissionGradedError`. The route
   maps it to 409.
3. Atomically soft-delete the conversation and delete the submission row.
4. Return the voided submission (id and `submitted_at`) so the caller can write a
   `submission.voided` audit event.

`softDeleteConversation` gains a fail-closed guard: it refuses to soft-delete a
`section` conversation that has a submission, and names
`restartSectionConversation` in the error. Without this, #27 could call the plain
soft-delete, leave the submission row behind pointing at a deleted conversation,
and reintroduce this bug through a different door. Tutor conversations are
unaffected — they can never have a submission.

### Atomicity

Production runs neon-http, which supports `db.batch()` but not
`db.transaction()`. The node-postgres driver used by real-DB tests is the mirror
image. `updateHomework` already resolves this by feature-detecting
`typeof db.batch === "function"`, with the branch written inline.

This spec extracts that branch into a `runAtomically` helper and uses it for the
two-statement restart write. `updateHomework` is deliberately **not** refactored
onto the helper: its two paths have structurally different bodies (one defers
statements into an array, the other awaits them against `tx`), so unifying them
needs a callback-per-statement design that is out of scope here. #202 already
tracks idiom drift of this kind; a pointer comment is left at both sites.

## Migration

Ordered so no step can leave the table half-constrained:

1. `ADD COLUMN user_id`, `section_id` — nullable.
2. Backfill from `conversations` via `conversation_id`.
3. `SET NOT NULL` on both.
4. Add the `conversations` unique triple.
5. Add the composite foreign key.
6. Add `UNIQUE (user_id, section_id)`.

If duplicate `(user_id, section_id)` rows already exist, step 6 fails and the
deploy stops. This is intended. A migration that silently deletes one of a
student's two submissions is worse than one that refuses to run, and the
remediation (decide which submission survives, delete the other, re-run) needs a
human. In practice duplicates cannot exist yet: no route soft-deletes a section
conversation today, because #27 is not built.

## Scope boundary

In scope: the decision, the schema constraints and migration, the repository
primitive, the audit action, and tests.

Out of scope: `POST /api/sections/:id/conversations`, the restart endpoint, and
the student-facing restart affordance. Those are #27's requirements. #128 exists
to hand #27 a primitive to call and a constraint that makes the accumulation
unreachable; #27 wires the HTTP layer and the UI.

`recordGrade` is also untouched — no route calls it, and #75 owns wiring it.

## Testing

- **Real Postgres (`.db.test.ts`)**: run #128's exact reproduction — submit A,
  soft-delete A, create B, submit B — and assert the second submit is now
  refused by the constraint. This reproduction is the regression proof for the
  whole spec; a mocked test cannot verify a database constraint.
- **Real Postgres**: the composite FK rejects a submission whose `user_id` or
  `section_id` disagrees with its conversation, and rejects a submission against
  a tutor conversation.
- **Mocked db**: `restartSectionConversation` ownership and not-found paths,
  the graded-submission 409 path, and that both driver branches issue the same
  two writes.
- **Mocked db**: `softDeleteConversation` refuses a submitted section
  conversation and still permits tutor and unsubmitted-section conversations.

Every fix is mutation-verified per this repo's standard: reverting the change
must fail a test.
