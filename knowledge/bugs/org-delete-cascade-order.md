---
type: Bug
title: Org deletion bypasses RESTRICT FKs because of cascade ordering
description: "Deleting an organization succeeds and cascades grades and LLM logs away even though user/submission paths RESTRICT, because the org's direct cascade FKs fire first; a reviewer's opposite claim had to be reverted."
tags: [database, postgres, ferpa, data-retention]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:25:31Z" }
status: stable
governance: constraint
code_refs: ["apps/web/src/db/schema/runtime.ts", "apps/web/src/db/schema/identity.ts", "apps/web/scripts/seed.ts"]
sources:
  - resource: "PR #127"
  - resource: "issue #138"
  - resource: "issue #133"
  - resource: "issue #51"
---

## Behaviour

After #133, grades and `llm_call_logs` are protected by `ON DELETE RESTRICT` on the submission and conversation paths, so deleting a user or conversation that has a grade or LLM log is blocked. **Deleting an organization is not blocked.** `DELETE FROM organizations` succeeds and cascades grades and LLM logs away.

## Why

Those tables also have a direct `organization_id` FK with CASCADE. Postgres fires FK triggers in an order tied to constraint creation, and the org's direct cascade removes the grade rows before the deeper RESTRICT on the submission path ever checks them.

## The lesson in the history (#138)

- In round 2 of the PR #127 review, the reviewer claimed the new RESTRICT FKs would make org deletion **abort**. The author documented that claim.
- In round 3, the reviewer re-tested with a minimal FK repro and the full migration set on pgvector. Org deletion actually **succeeds**. The doc, three code comments and a tautological regression test were corrected. The new test asserts the real behaviour.
- Conclusion: reason about cascade versus restrict interactions empirically. Write a test that asserts the actual outcome against a real Postgres, not one derived from the expected constraint semantics.

## Implications

- Org deletion is a FERPA-relevant destructive path. Any real org-offboarding or retention flow (#51) needs an explicit, audited deletion order and must not rely on RESTRICT as a safety net.
- `seed.ts reset()` clears the seed org's grades and LLM logs explicitly before deleting it, scoped to the seed org only, and refuses a non-local `DATABASE_URL` without `--force` (#130).
