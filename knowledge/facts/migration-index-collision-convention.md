---
type: Fact
title: "Drizzle migration numbering: PR-open order wins, CI checks collisions"
description: "Parallel PRs off the same staging head generate the same drizzle migration index; rule: the earlier-opened PR keeps it, the later one renumbers and re-chains snapshots; CI job migration-index-collision enforces."
tags: [database, migrations, drizzle, ci, process]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:30:53Z" }
status: stable
governance: constraint
code_refs: [".gitattributes", ".github/workflows/test.yml", "apps/web/README.md", "apps/web/drizzle.config.ts", "apps/web/src/db/migrations", "apps/web/src/db/migrations/meta/_journal.json"]
sources:
  - resource: "issue #373"
  - resource: "PR #317"
  - resource: "PR #363"
  - resource: "PR #366"
  - resource: "apps/web/README.md"
  - resource: ".github/workflows/test.yml"
  - resource: "apps/web/ARCHITECTURE.md"
  - resource: "2f87a18"
---

## Problem (#373)

Drizzle numbers migrations sequentially (`NNNN_description.sql`) from whatever is on the branch base at generation time. Two PRs branched from the same `staging` head both claim the next index. It happened twice in two days: #317 and #363 collided on 0027–0029, then #363 and #366 both claimed 0040. Renaming the file is not enough, because drizzle snapshots carry a `prevId`/`id` chain and `meta/_journal.json` has to agree. Each collision cost a full renumber-and-rechain pass, made worse when both PRs touched the same schema file (`schema/content.ts`).

## Rule (documented in `apps/web/README.md`, section Migrations)

- **Migration index claims follow PR-open order.** The PR opened first keeps its index or indexes.
- A later PR that collides must renumber after the earlier one merges. Either regenerate with `drizzle-kit generate` against the current `staging`, or hand-renumber the SQL file, its `meta/<idx>_snapshot.json` and its `_journal.json` entry, keeping the chain intact.

## Enforcement

`.github/workflows/test.yml` has a `migration-index-collision` job, run on pull_request only. It fails if the PR adds a migration whose `NNNN` prefix already exists on the base branch under a different filename, so the collision shows up at push time instead of merge time.

## Related migration conventions

- Migrations must run before the new app version serves traffic (see facts/migrate-before-deploy-and-candidate-activation).
- CONCURRENTLY index builds must use `IF NOT EXISTS` and be replay-safe (see bugs/invalid-concurrent-index-skipped).
- Backfills must not assume invariants the schema does not enforce. #240 (open): migration 0021's backfill assumed every submission was against a section conversation, which only application code enforced.

## From the issue tracker and reviews

**Layout.** `apps/web/drizzle.config.ts`: schema `./src/db/schema.ts`, out `./src/db/migrations`, dialect postgresql, `strict: true`, `verbose: true`. Each migration is `NNNN_<tag>.sql` with an entry `{idx, version:"7", when, tag, breakpoints:true}` in `meta/_journal.json`. As of HEAD there are 56 entries, 0000 to 0055. `meta/` is marked `linguist-generated` in `.gitattributes`.

**Snapshots are not complete.** `meta/` has snapshots for 0000-0048, 0054 and 0055; 0049-0053 were hand-authored without snapshots. drizzle-kit only diffs the schema against the latest snapshot, so this is harmless, but do not assume `NNNN_snapshot.json` exists for every index. `npx drizzle-kit generate` on HEAD reports "No schema changes, nothing to migrate" (verified), meaning schema.ts and 0055's snapshot agree.

**Numbering (#373).** drizzle numbers sequentially off your branch. Two PRs from the same base generate the same next index. Rule: whichever PR opened first keeps the index; the later PR renumbers after the earlier merges, either by regenerating against the new base or by hand-renaming the SQL file, its snapshot and its journal entry while keeping the snapshot `prevId`/`id` chain intact. Precedents: #317/#363 on 0027-0029; #363/#366 on 0040.

**CI guard.** test.yml job `migration-index-collision` (PRs only) fails if the PR adds `NNNN_*.sql` whose index already exists on the base branch under a different filename.

**Never:**
- edit or rename a migration that has been applied to any shared database (staging, production, the shared dev Neon). drizzle tracks by journal order/hash in `__drizzle_migrations`; write a new migration instead.
- hand-edit `_journal.json` except for a renumber, and keep `when` monotonically increasing.
- delete a snapshot that a later snapshot's `prevId` points at.

Custom data migrations are fine (several are hand-named, e.g. `0029_default_llm_configs_and_provider_backfill.sql`); generate an empty one with `npx drizzle-kit generate --custom --name=<tag>` from `apps/web` so the journal stays consistent.
