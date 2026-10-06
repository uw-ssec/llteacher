---
type: Fact
title: Adding NOT NULL columns to messages needs explicit backfill
description: "drizzle-kit output for a NOT NULL column on populated tables like messages assigns values in heap-scan order; hand-apply nullable add, ORDER BY backfill, then SET NOT NULL (done in 0018, 0021, 0023)."
tags: [migrations, postgres, messages, gotcha]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:30:53Z" }
status: stable
governance: constraint
code_refs: ["apps/web/src/db/schema/runtime.ts", "apps/web/src/db/migrations/0023_chunky_scarecrow.sql", "apps/web/src/db/migrations/0023-seq-backfill.db.test.ts", "apps/web/ARCHITECTURE.md"]
sources:
  - resource: "apps/web/ARCHITECTURE.md"
---

`messages` is the fastest-growing table and is never empty by the time a migration reaches a real deployment. A plain `drizzle-kit generate` diff for a `NOT NULL` column with no explicit default (especially a `bigserial`) lets Postgres's `ALTER TABLE` rewrite assign values in whatever order it scans the heap. That order has no relationship to `created_at` and differs between fresh tables and tables with deletes or VACUUM history. #269 reproduced silent reordering on Postgres 16 both via free-space reuse and via `synchronize_seqscans` with zero deletes.

**Rule (hand-applied in 0018, 0021, 0023):**
1. Add the column nullable.
2. Backfill with an explicit `UPDATE ... ORDER BY` (or `row_number() OVER (ORDER BY created_at, id)` into a real sequence for strictly ordered columns like `seq`).
3. `ALTER COLUMN ... SET NOT NULL`.

Never trust raw drizzle-kit output for a NOT NULL column on this table without checking for a backfill. `0023-seq-backfill.db.test.ts` (inside the migrations folder; picked up by vitest's `src/**/*.test.ts` glob, skipped without `DATABASE_URL`) guards the 0023 case.

**Why `seq` matters:** `messages.seq` is the only correct ordering key (`getLastMessages`, `getMessagesForConversation`, `getSectionConversationMessages`). Keep `created_at` for display only.

**Scale threshold (judgment call, #311):** once `messages` passes about 1,000,000 rows or one academic term of pilot usage, the online pattern (nullable/backfill/NOT NULL plus `CONCURRENTLY` index builds) becomes mandatory rather than recommended. Below that, a blocking DDL migration in a maintenance window is accepted. 0023's column add and index builds used ordinary DDL and took ACCESS EXCLUSIVE; that was fine at the time's volume.

Retention: no deletion job exists; messages are graded-work evidence, so archive rather than delete when the threshold is hit.
