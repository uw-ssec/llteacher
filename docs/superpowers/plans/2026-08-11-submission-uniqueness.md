# Submission Uniqueness (#128) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make it structurally impossible for a student to accumulate more than one `submissions` row for the same section, and give #27 a restart primitive that voids the submission instead of orphaning it.

**Architecture:** Denormalize `user_id`/`section_id` onto `submissions`, hold them honest with a composite foreign key back to `conversations(id, owner_user_id, section_id)`, then put a plain `UNIQUE (user_id, section_id)` on top. Add a `restartSectionConversation` repository primitive that atomically soft-deletes the conversation and deletes its submission, and make the bare `softDeleteConversation` refuse the case it would get wrong.

**Tech Stack:** TypeScript, Drizzle ORM, Postgres 16 (pgvector image), Hono, Vitest. Production driver is `@neondatabase/serverless` (neon-http); real-DB tests use `node-postgres` via `makeNodeDb`.

## Global Constraints

- Migrations are additive and ordered: add nullable → backfill → `SET NOT NULL` → add constraints. Never reorder.
- The migration must **fail loudly** on pre-existing duplicates. Never delete a student's submission to make an index build.
- Do not create `apps/web/src/server/repositories/errors.ts` — PR #212 creates that file. Define the new error class in `submissions.ts` and leave a pointer comment.
- Do not add an HTTP route, an `AUDIT_ACTIONS` entry, or UI. Those belong to #27. Adding an audit constant with no writer is dead code.
- Every behavioral change must be mutation-verified: reverting the source must fail at least one test.
- Real-DB suites use `describe.skipIf(!process.env.DATABASE_URL)`, matching every other `.db.test.ts` in the repo.
- Run tests with `npx vitest run <path>` from `apps/web`, or `npm test` from the repo root for the full workspace sweep.

---

### Task 1: Schema, migration, and the constraint that closes #128

**Files:**
- Modify: `apps/web/src/db/schema/runtime.ts` (`conversations` extra config ~line 68-95; `submissions` ~line 160-176)
- Modify: `apps/web/src/server/repositories/submissions.ts:8-40` (`createSubmission`)
- Create: `apps/web/src/db/migrations/0021_submission_section_uniqueness.sql`
- Modify: `apps/web/src/db/migrations/meta/_journal.json`
- Create: `apps/web/src/server/repositories/submissions.db.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `submissions.userId` / `submissions.sectionId` columns, used by Task 3's delete predicate; `createSubmission(db, scope, conversationId)` keeps its existing signature and return type.

- [ ] **Step 1: Write the failing real-DB test**

Create `apps/web/src/server/repositories/submissions.db.test.ts`. This runs #128's exact reproduction. A mocked db cannot verify a database constraint, which is the entire point of this issue.

```ts
/* --------------------------------------------------------------------------
   #128 reproduction, against a real Postgres.

   M2 shipped UNIQUE(submissions.conversation_id) and a partial unique index
   allowing one *active* conversation per (student, section). Neither bounds
   submissions per (student, section) across time: submit A, soft-delete A,
   create B for the same section, submit B -- two rows. Reproduced here so
   the constraint added in this task has a failing test behind it.
   -------------------------------------------------------------------------- */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { makeNodeDb } from "../../db/nodeClient";
import type { Db } from "../../db/client";
import { unsafeOrgScope } from "./scope";
import { createSubmission } from "./submissions";
import {
  organizations, courses, users, courseMemberships,
  homeworks, sections, conversations, submissions,
} from "../../db/schema";

const RAW_DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!RAW_DATABASE_URL)("submissions uniqueness (real DB, #128)", () => {
  let db: Db;
  let orgId: string;
  let courseId: string;
  let sectionId: string;
  let userId: string;

  beforeAll(async () => {
    db = makeNodeDb(RAW_DATABASE_URL!);

    const [org] = await db.insert(organizations)
      .values({ name: "128-org", slug: `s128-${crypto.randomUUID().slice(0, 8)}` })
      .returning({ id: organizations.id });
    orgId = org!.id;

    const [course] = await db.insert(courses)
      .values({ organizationId: orgId, code: `C-${crypto.randomUUID().slice(0, 8)}`, term: "T", title: "t" })
      .returning({ id: courses.id });
    courseId = course!.id;

    const [user] = await db.insert(users)
      .values({ email: Buffer.from("e"), emailBlindIndex: crypto.randomUUID() })
      .returning({ id: users.id });
    userId = user!.id;

    await db.insert(courseMemberships).values({ userId, courseId, role: "student" });

    const [hw] = await db.insert(homeworks)
      .values({ courseId, title: "hw", description: "d", dueDate: new Date(Date.now() + 86_400_000) })
      .returning({ id: homeworks.id });

    const [section] = await db.insert(sections)
      .values({ homeworkId: hw!.id, title: "s", content: "c", order: 1 })
      .returning({ id: sections.id });
    sectionId = section!.id;
  });

  afterAll(async () => {
    if (orgId) await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  async function makeSectionConversation() {
    const [c] = await db.insert(conversations)
      .values({ ownerUserId: userId, courseId, sectionId, kind: "section", title: "c" })
      .returning({ id: conversations.id });
    return c!.id;
  }

  it("refuses a second submission for the same (student, section) after delete-and-recreate", async () => {
    const scope = unsafeOrgScope(orgId);

    const convA = await makeSectionConversation();
    await createSubmission(db, scope, convA);

    // Soft-delete A -- this is what frees the partial unique index and lets
    // B exist, and is exactly what #27's delete-and-restart will do.
    await db.update(conversations)
      .set({ isDeleted: true, deletedAt: new Date() })
      .where(eq(conversations.id, convA));

    const convB = await makeSectionConversation();

    // Before this task: succeeds, leaving two rows. After: rejected by
    // submissions_user_section_uq.
    await expect(createSubmission(db, scope, convB)).rejects.toThrow();

    const rows = await db.select().from(submissions).where(eq(submissions.userId, userId));
    expect(rows).toHaveLength(1);
  });

  it("rejects a submission whose denormalized pair disagrees with its conversation", async () => {
    const conv = await makeSectionConversation();
    // Hand-written insert bypassing createSubmission: the composite FK, not
    // application code, is what must reject this.
    await expect(
      db.insert(submissions).values({
        conversationId: conv,
        organizationId: orgId,
        userId,
        sectionId: crypto.randomUUID(),
      }),
    ).rejects.toThrow();
  });

  it("rejects a submission against a tutor conversation", async () => {
    const [tutor] = await db.insert(conversations)
      .values({ ownerUserId: userId, courseId, sectionId: null, kind: "tutor", title: "t" })
      .returning({ id: conversations.id });
    await expect(
      db.insert(submissions).values({
        conversationId: tutor!.id,
        organizationId: orgId,
        userId,
        sectionId,
      }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it and confirm the first test fails**

```bash
cd apps/web && npx vitest run src/server/repositories/submissions.db.test.ts
```

Expected: the first test FAILS (the second `createSubmission` resolves instead of rejecting, and two rows exist). The second and third tests fail to compile — `userId`/`sectionId` are not yet columns. That compile failure is expected and is fixed by Step 3.

If the suite reports "skipped", `DATABASE_URL` is unset. Start Postgres and export it before continuing — this task cannot be verified without a real database.

- [ ] **Step 3: Add the columns and constraints to the Drizzle schema**

In `apps/web/src/db/schema/runtime.ts`, add `unique` and `foreignKey` to the existing `drizzle-orm/pg-core` import list.

Add to the `conversations` extra-config array (the `(t) => [...]` block), after the existing `uniqueIndex`:

```ts
    // Referenceable triple for submissions' composite FK below. `id` alone
    // is already unique, so this adds no new integrity rule to
    // conversations -- it exists solely so Postgres will accept
    // (conversation_id, user_id, section_id) as a foreign key target, which
    // requires a unique constraint on exactly those referenced columns.
    unique("conversations_id_owner_section_uq").on(t.id, t.ownerUserId, t.sectionId),
```

Replace the `submissions` table definition's columns and extra config:

```ts
export const submissions = pgTable(
  "submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .unique()
      .references(() => conversations.id, { onDelete: "cascade" }),
    // #128: denormalized from the owning conversation so that "one
    // submission per (student, section)" becomes expressible at all --
    // submissions previously carried neither column, which is why the
    // soft-delete-and-recreate cycle could accumulate rows undetected.
    // Kept honest by submissions_conversation_owner_section_fk below, not
    // by convention: without that FK these would be correct only as long as
    // every writer remembered to copy them, and the unique index would be
    // enforcing a pair that could drift from the conversation it names.
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sectionId: uuid("section_id")
      .notNull()
      .references(() => sections.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    submittedAt: timestamp("submitted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("submissions_org_idx").on(t.organizationId),
    // The composite FK. Two consequences beyond keeping the pair honest:
    // (1) section_id is NOT NULL here while a tutor conversation's is NULL,
    // and NOT NULL never matches NULL, so a submission against a tutor
    // conversation is now structurally impossible rather than merely
    // rejected by createSubmission's kind check; (2) it makes the unique
    // index below trustworthy.
    foreignKey({
      name: "submissions_conversation_owner_section_fk",
      columns: [t.conversationId, t.userId, t.sectionId],
      foreignColumns: [conversations.id, conversations.ownerUserId, conversations.sectionId],
    }).onDelete("cascade"),
    // #128, the actual fix. UNIQUE(conversation_id) above only ever caught
    // a second submit of the *same* conversation.
    uniqueIndex("submissions_user_section_uq").on(t.userId, t.sectionId),
  ],
);
```

- [ ] **Step 4: Write the migration**

Create `apps/web/src/db/migrations/0021_submission_section_uniqueness.sql`. Hand-written rather than pure `drizzle-kit generate` output because the backfill in statements 2-3 is not something drizzle-kit can infer.

```sql
--> #128: submissions gains the (user_id, section_id) pair it never had, so
--> "one submission per student per section" becomes expressible. Ordered
--> add-nullable -> backfill -> SET NOT NULL -> constraints, so no step can
--> leave the table half-constrained on a partial apply.
ALTER TABLE "submissions" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "section_id" uuid;--> statement-breakpoint

--> Backfill from the owning conversation. Every existing submission is
--> against a kind='section' conversation (createSubmission has always
--> required it), so section_id is non-null for every row this touches.
UPDATE "submissions" s
   SET "user_id" = c."owner_user_id",
       "section_id" = c."section_id"
  FROM "conversations" c
 WHERE c."id" = s."conversation_id";--> statement-breakpoint

ALTER TABLE "submissions" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "submissions" ALTER COLUMN "section_id" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "submissions" ADD CONSTRAINT "submissions_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_section_id_sections_id_fk"
  FOREIGN KEY ("section_id") REFERENCES "public"."sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

--> Referenceable target for the composite FK below. conversations.id is
--> already the PK, so this weakens nothing.
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_id_owner_section_uq"
  UNIQUE ("id", "owner_user_id", "section_id");--> statement-breakpoint

ALTER TABLE "submissions" ADD CONSTRAINT "submissions_conversation_owner_section_fk"
  FOREIGN KEY ("conversation_id", "user_id", "section_id")
  REFERENCES "public"."conversations"("id", "owner_user_id", "section_id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

--> If this statement fails with a uniqueness violation, the database
--> already contains the duplicate this issue describes. Do NOT "fix" it by
--> deleting a row here: which of a student's two submissions survives is a
--> decision for the instructor, not for a migration. Resolve manually
--> (SELECT user_id, section_id FROM submissions GROUP BY 1,2 HAVING
--> count(*) > 1), then re-run. In practice this cannot fire yet -- no route
--> soft-deletes a section conversation, because #27 is not built.
CREATE UNIQUE INDEX "submissions_user_section_uq" ON "submissions" ("user_id","section_id");
```

Append to `apps/web/src/db/migrations/meta/_journal.json`'s `entries` array (use a `when` value greater than 1786390637880):

```json
    {
      "idx": 21,
      "version": "7",
      "when": 1786800000000,
      "tag": "0021_submission_section_uniqueness",
      "breakpoints": true
    }
```

- [ ] **Step 5: Teach `createSubmission` to write the new columns**

In `apps/web/src/server/repositories/submissions.ts`, the existing scope-verification `select` already joins `conversations`. Widen its projection and use it for the insert, so the values written are the ones just read from the conversation rather than a second, separately-fetched copy:

```ts
  const [owned] = await db
    .select({
      id: conversations.id,
      ownerUserId: conversations.ownerUserId,
      sectionId: conversations.sectionId,
    })
    .from(conversations)
    .innerJoin(courses, eq(conversations.courseId, courses.id))
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(courses.organizationId, scope),
        eq(conversations.isDeleted, false),
        eq(conversations.kind, "section"),
      ),
    );
  if (!owned) {
    throw new Error("Conversation not found in this org scope");
  }

  const [created] = await db
    .insert(submissions)
    .values({
      conversationId,
      organizationId: scope,
      // #128: taken from the row just verified above, not re-fetched -- the
      // composite FK would reject a mismatch anyway, but sourcing both from
      // one read means there is no window in which they could disagree.
      // The kind='section' predicate above guarantees sectionId is non-null.
      userId: owned.ownerUserId,
      sectionId: owned.sectionId!,
    })
    .returning();
  return created;
```

- [ ] **Step 6: Apply the migration and run the real-DB test**

```bash
cd apps/web && npm run db:migrate && npx vitest run src/server/repositories/submissions.db.test.ts
```

Expected: all three tests PASS.

- [ ] **Step 7: Verify the schema and the migration agree**

```bash
cd apps/web && npx drizzle-kit generate
git status --short apps/web/src/db/migrations
```

Expected: no new migration file. If drizzle-kit emits one, the hand-written SQL in Step 4 does not match the schema in Step 3 — reconcile before continuing, and delete the generated file.

- [ ] **Step 8: Run the full suite for regressions**

```bash
npm test && npm run typecheck
```

Expected: all pass. Existing `submissions` inserts in other tests may need the two new fields; fix any that fail.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/db/schema/runtime.ts \
        apps/web/src/db/migrations/0021_submission_section_uniqueness.sql \
        apps/web/src/db/migrations/meta/_journal.json \
        apps/web/src/server/repositories/submissions.ts \
        apps/web/src/server/repositories/submissions.db.test.ts
git commit -m "fix(db): bound submissions to one per (student, section) (#128)"
```

---

### Task 2: `runAtomically` helper

**Files:**
- Create: `apps/web/src/server/repositories/atomic.ts`
- Create: `apps/web/src/server/repositories/atomic.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `runAtomically(db: Db, build: (t: Db) => BatchStatement[]): Promise<void>` — used by Task 3.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { runAtomically } from "./atomic";
import type { Db } from "../../db/client";

describe("runAtomically", () => {
  it("uses db.batch when the driver provides it (production/neon-http)", async () => {
    const batch = vi.fn().mockResolvedValue(undefined);
    const transaction = vi.fn();
    const db = { batch, transaction } as unknown as Db;

    await runAtomically(db, () => ["s1", "s2"] as never[]);

    expect(batch).toHaveBeenCalledWith(["s1", "s2"]);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("falls back to db.transaction when batch is absent (tests/node-postgres)", async () => {
    const awaited: unknown[] = [];
    const transaction = vi.fn(async (fn: (tx: Db) => Promise<void>) => {
      await fn({ marker: "tx" } as unknown as Db);
    });
    const db = { transaction } as unknown as Db;

    await runAtomically(db, (t) => {
      awaited.push(t);
      return [Promise.resolve("a"), Promise.resolve("b")] as never[];
    });

    expect(transaction).toHaveBeenCalled();
    // build() receives the transaction handle, not the outer db, so every
    // statement it constructs is bound to the transaction.
    expect(awaited).toEqual([{ marker: "tx" }]);
  });

  it("does not call the driver at all when there is nothing to write", async () => {
    const batch = vi.fn();
    const transaction = vi.fn();
    await runAtomically({ batch, transaction } as unknown as Db, () => []);
    expect(batch).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd apps/web && npx vitest run src/server/repositories/atomic.test.ts
```

Expected: FAIL — cannot resolve `./atomic`.

- [ ] **Step 3: Implement**

```ts
import type { Db } from "../../db/client";

/** One statement in an atomic group. Drizzle's query-builder objects are
 *  thenable, so the same value works as a batch item and as something a
 *  transaction body can await. */
export type BatchStatement = Parameters<Db["batch"]>[0][number];

/** Runs a group of writes all-or-nothing across both drivers this repo uses.
 *
 *  Production is neon-http, which has `db.batch()` and no `db.transaction()`.
 *  The node-postgres client real-DB tests use (`makeNodeDb`) is the mirror
 *  image -- `db.transaction()` works and `db.batch` is absent at runtime
 *  despite the shared `Db` type claiming otherwise. Feature-detect rather
 *  than try/catch: a missing method is a TypeError at the call site, not an
 *  error to catch.
 *
 *  `build` is called with the handle the statements must be bound to -- the
 *  outer db on the batch path, the transaction handle on the fallback path.
 *  Building against the wrong handle on the fallback path would run the
 *  writes outside the transaction, which is the failure this signature
 *  exists to prevent.
 *
 *  repositories/homeworks.ts's updateHomework predates this helper and keeps
 *  its own inline copy of the same branch: its two paths have structurally
 *  different bodies (one defers statements into an array, the other awaits
 *  them against `tx`), so it needs a callback-per-statement shape this
 *  helper deliberately does not have. Tracked with the rest of the idiom
 *  drift in #202. */
export async function runAtomically(
  db: Db,
  build: (target: Db) => BatchStatement[],
): Promise<void> {
  if (typeof db.batch === "function") {
    const statements = build(db);
    if (statements.length === 0) return;
    await db.batch(statements as [BatchStatement, ...BatchStatement[]]);
    return;
  }

  // Nothing to write: don't open a transaction just to close it.
  if (build(db).length === 0) return;

  await db.transaction(async (tx) => {
    for (const statement of build(tx as unknown as Db)) {
      await statement;
    }
  });
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd apps/web && npx vitest run src/server/repositories/atomic.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/repositories/atomic.ts apps/web/src/server/repositories/atomic.test.ts
git commit -m "refactor(db): extract runAtomically for the two-driver write split (#128)"
```

---

### Task 3: `restartSectionConversation` and the fail-closed soft-delete guard

**Files:**
- Modify: `apps/web/src/server/repositories/submissions.ts` (append)
- Modify: `apps/web/src/server/repositories/conversations.ts:73-78` (`softDeleteConversation`)
- Create: `apps/web/src/server/repositories/restartSectionConversation.test.ts`
- Modify: `apps/web/src/server/repositories/submissions.db.test.ts` (append a real-DB case)

**Interfaces:**
- Consumes: `runAtomically` (Task 2); `submissions.userId`/`sectionId` (Task 1).
- Produces:
  - `class SubmissionGradedError extends Error` — exported from `submissions.ts`.
  - `restartSectionConversation(db: Db, scope: OrgScope, conversationId: string, requesterId: string): Promise<{ voidedSubmission: { id: string; submittedAt: Date } | null }>`
  - `softDeleteConversation` unchanged in signature; now throws when refusing.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/server/repositories/restartSectionConversation.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { restartSectionConversation, SubmissionGradedError } from "./submissions";
import { unsafeOrgScope } from "./scope";
import type { Db } from "../../db/client";

const SCOPE = unsafeOrgScope("org-1");
const CONV = "11111111-2222-4333-8444-555555555555";
const OWNER = "owner-1";

/** Minimal db double. `selects` is a queue: each call to .select() shifts the
 *  next canned result, in the order restartSectionConversation issues them
 *  (1: conversation ownership, 2: submission lookup, 3: grade lookup). */
function makeDb(selects: unknown[][]) {
  const batch = vi.fn().mockResolvedValue(undefined);
  const queue = [...selects];
  const db = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({ where: async () => queue.shift() ?? [] }),
        where: async () => queue.shift() ?? [],
      }),
    }),
    update: () => ({ set: () => ({ where: () => "update-stmt" }) }),
    delete: () => ({ where: () => "delete-stmt" }),
    batch,
  } as unknown as Db;
  return { db, batch };
}

describe("restartSectionConversation", () => {
  it("throws when the conversation is not found or not accessible", async () => {
    const { db } = makeDb([[]]);
    await expect(restartSectionConversation(db, SCOPE, CONV, OWNER))
      .rejects.toThrow("Conversation not found or not accessible");
  });

  it("throws when the requester does not own the conversation", async () => {
    const { db } = makeDb([[{ id: CONV, ownerUserId: "someone-else" }]]);
    await expect(restartSectionConversation(db, SCOPE, CONV, OWNER))
      .rejects.toThrow("Conversation is not owned by requester");
  });

  it("refuses to restart a graded submission", async () => {
    const { db, batch } = makeDb([
      [{ id: CONV, ownerUserId: OWNER }],
      [{ id: "sub-1", submittedAt: new Date() }],
      [{ id: "grade-1" }],
    ]);
    await expect(restartSectionConversation(db, SCOPE, CONV, OWNER))
      .rejects.toBeInstanceOf(SubmissionGradedError);
    // Nothing was written -- the guard must run before the atomic group.
    expect(batch).not.toHaveBeenCalled();
  });

  it("soft-deletes the conversation and voids the submission in one atomic group", async () => {
    const submittedAt = new Date();
    const { db, batch } = makeDb([
      [{ id: CONV, ownerUserId: OWNER }],
      [{ id: "sub-1", submittedAt }],
      [],
    ]);
    const result = await restartSectionConversation(db, SCOPE, CONV, OWNER);

    expect(result.voidedSubmission).toEqual({ id: "sub-1", submittedAt });
    // Both writes in a single batch, not two independent awaits: a partial
    // apply would leave a submission pointing at a deleted conversation.
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]![0]).toEqual(["update-stmt", "delete-stmt"]);
  });

  it("soft-deletes with no submission to void", async () => {
    const { db, batch } = makeDb([[{ id: CONV, ownerUserId: OWNER }], [], []]);
    const result = await restartSectionConversation(db, SCOPE, CONV, OWNER);

    expect(result.voidedSubmission).toBeNull();
    expect(batch.mock.calls[0]![0]).toEqual(["update-stmt"]);
  });
});
```

Append to `apps/web/src/server/repositories/conversations.test.ts` (or create a `describe` block there) a guard test:

```ts
describe("softDeleteConversation fail-closed guard (#128)", () => {
  it("refuses a section conversation that has a submission", async () => {
    // conversation lookup returns a submitted section conversation
    const db = {
      select: () => ({ from: () => ({ where: async () => [{ id: "c1", kind: "section" }] }) }),
      update: () => ({ set: () => ({ where: async () => undefined }) }),
    } as unknown as Db;

    await expect(softDeleteConversation(db, unsafeCourseScope("course-1"), "c1"))
      .rejects.toThrow(/restartSectionConversation/);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd apps/web && npx vitest run src/server/repositories/restartSectionConversation.test.ts src/server/repositories/conversations.test.ts
```

Expected: FAIL — `restartSectionConversation` and `SubmissionGradedError` are not exported.

- [ ] **Step 3: Implement `restartSectionConversation`**

Append to `apps/web/src/server/repositories/submissions.ts` (add `grades` to the schema import if absent, and import `runAtomically` from `./atomic`):

```ts
/** A restart was refused because the submission has already been graded.
 *
 *  Distinct from the plain Errors above so the route layer (#27) can map it
 *  to a 409 rather than a generic failure. Defined here rather than in a
 *  shared errors module because PR #212 introduces
 *  repositories/errors.ts with TenancyMismatchError; this class should move
 *  alongside it once that lands, rather than the two files racing to create
 *  the same module. */
export class SubmissionGradedError extends Error {
  constructor() {
    super("Submission has already been graded and cannot be restarted");
    this.name = "SubmissionGradedError";
  }
}

/** Delete-and-restart's data-layer half (#128, for #27 to wire).
 *
 *  Restarting a section VOIDS its submission: the student returns to a
 *  not-submitted state and re-submits the new conversation when done. The
 *  alternatives were considered and rejected in
 *  docs/superpowers/specs/2026-08-11-submission-uniqueness-design.md --
 *  superseding would report "submitted" for a conversation containing no
 *  work, and locking would make an unbuilt instructor reopen flow a
 *  dependency of restart.
 *
 *  A graded submission cannot be restarted. The check below produces a
 *  useful error, but it is not the only thing enforcing it: grades.
 *  submission_id is a RESTRICT foreign key, so Postgres refuses the delete
 *  regardless of whether a caller remembered to check.
 *
 *  Does NOT create the replacement conversation -- #27 owns that, along with
 *  the route, the greeting message, and writing a `submission.voided` audit
 *  event from the returned value. Deliberately no AUDIT_ACTIONS entry is
 *  added here: a constant with no writer is dead code. */
export async function restartSectionConversation(
  db: Db,
  scope: OrgScope,
  conversationId: string,
  requesterId: string,
): Promise<{ voidedSubmission: { id: string; submittedAt: Date } | null }> {
  // Same check shape and the same deliberate two-message split as
  // submitSection above: the repository reports "absent" and "not yours"
  // distinctly, and the route decides which to collapse rather than having
  // that choice forced on it by a single indistinguishable message.
  const [owned] = await db
    .select({ id: conversations.id, ownerUserId: conversations.ownerUserId })
    .from(conversations)
    .innerJoin(courses, eq(conversations.courseId, courses.id))
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(courses.organizationId, scope),
        eq(conversations.isDeleted, false),
        eq(conversations.kind, "section"),
      ),
    );
  if (!owned) {
    throw new Error("Conversation not found or not accessible");
  }
  if (owned.ownerUserId !== requesterId) {
    throw new Error("Conversation is not owned by requester");
  }

  const [submission] = await db
    .select({ id: submissions.id, submittedAt: submissions.submittedAt })
    .from(submissions)
    .where(and(eq(submissions.conversationId, conversationId), eq(submissions.organizationId, scope)));

  if (submission) {
    const [grade] = await db
      .select({ id: grades.id })
      .from(grades)
      .where(eq(grades.submissionId, submission.id));
    if (grade) {
      throw new SubmissionGradedError();
    }
  }

  // One atomic group. Split into two awaits, a failure between them would
  // leave a submission row referencing a soft-deleted conversation -- the
  // exact shape #128 exists to make unrepresentable.
  await runAtomically(db, (t) => [
    t.update(conversations)
      .set({ isDeleted: true, deletedAt: new Date() })
      .where(eq(conversations.id, conversationId)),
    ...(submission ? [t.delete(submissions).where(eq(submissions.id, submission.id))] : []),
  ]);

  return {
    voidedSubmission: submission ? { id: submission.id, submittedAt: submission.submittedAt } : null,
  };
}
```

- [ ] **Step 4: Add the fail-closed guard to `softDeleteConversation`**

Replace `softDeleteConversation` in `apps/web/src/server/repositories/conversations.ts`:

```ts
/** Enforces CourseScope only -- any member of the course can soft-delete any
 *  other student's conversation by UUID, since ownerUserId isn't checked.
 *  Not yet exploitable (no route calls this), but see ARCHITECTURE.md's "Row
 *  Ownership (Within a Scope)" section and issue #134: when a route wires
 *  this, it should grow a requesterId parameter for that check.
 *
 *  #128: refuses a `section` conversation that already has a submission.
 *  Soft-deleting one here would leave the submission row alive, pointing at
 *  a conversation the student can no longer see -- and the moment they start
 *  a replacement and submit it, a second row for the same section. Callers
 *  that mean "start over" want restartSectionConversation (submissions.ts),
 *  which voids the submission in the same atomic group. Tutor conversations
 *  can never have a submission, so they are unaffected. */
export async function softDeleteConversation(db: Db, scope: CourseScope, conversationId: string) {
  const [blocking] = await db
    .select({ id: submissions.id })
    .from(submissions)
    .innerJoin(conversations, eq(submissions.conversationId, conversations.id))
    .where(and(eq(conversations.id, conversationId), eq(conversations.courseId, scope)));
  if (blocking) {
    throw new Error(
      "Conversation has a submission; use restartSectionConversation to void it (#128)",
    );
  }

  return db
    .update(conversations)
    .set({ isDeleted: true, deletedAt: new Date() })
    .where(and(eq(conversations.id, conversationId), eq(conversations.courseId, scope)));
}
```

Add `submissions` to the schema import in `conversations.ts`.

- [ ] **Step 5: Add the real-DB restart case**

Append inside the existing `describe` in `submissions.db.test.ts`:

```ts
  it("restart voids the submission, freeing the section for a fresh submit", async () => {
    const scope = unsafeOrgScope(orgId);
    const convA = await makeSectionConversation();
    await createSubmission(db, scope, convA);

    const { voidedSubmission } = await restartSectionConversation(db, scope, convA, userId);
    expect(voidedSubmission).not.toBeNull();

    // The whole point: the section is submittable again, which the unique
    // index would otherwise forbid.
    const convB = await makeSectionConversation();
    await expect(createSubmission(db, scope, convB)).resolves.toBeDefined();

    const rows = await db.select().from(submissions).where(eq(submissions.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.conversationId).toBe(convB);
  });
```

Add `restartSectionConversation` to the import at the top of that file.

- [ ] **Step 6: Run all affected tests**

```bash
cd apps/web && npx vitest run src/server/repositories/
```

Expected: PASS.

- [ ] **Step 7: Mutation-verify**

Temporarily delete the `if (grade) throw new SubmissionGradedError()` block and re-run — the graded test must fail. Restore it. Then temporarily change `runAtomically`'s call to two separate awaits — the "one atomic group" test must fail. Restore.

- [ ] **Step 8: Full suite and commit**

```bash
npm test && npm run typecheck
git add apps/web/src/server/repositories/
git commit -m "feat(db): restart voids a section submission atomically (#128)"
```

---

### Task 4: Documentation and issue cross-references

**Files:**
- Modify: `apps/web/ARCHITECTURE.md`
- Modify: `docs/architecture/multi-tenant-data-model.md` (§3.5 open question 1)

- [ ] **Step 1: Document the rule in ARCHITECTURE.md**

Add a section near the existing tenancy/ownership conventions:

```markdown
### Section submissions are one per (student, section)

`submissions` carries denormalized `user_id`/`section_id` kept honest by a
composite foreign key to `conversations(id, owner_user_id, section_id)`, with
`UNIQUE (user_id, section_id)` on top. Do not write those two columns from
anywhere except the conversation the submission is being created against —
the FK will reject a mismatch, but sourcing them from a second read invites
a window where they disagree.

Restarting a section **voids** its submission: use
`restartSectionConversation`, never a bare `softDeleteConversation`, which
refuses a submitted section conversation for this reason. A graded submission
cannot be restarted; `grades.submission_id` is a RESTRICT FK, so this holds
even if an application check is missed. Rationale and rejected alternatives:
`docs/superpowers/specs/2026-08-11-submission-uniqueness-design.md`.
```

- [ ] **Step 2: Close the open question in the data-model doc**

In `docs/architecture/multi-tenant-data-model.md` §3.5, mark open question 1 resolved and link the spec. Do not delete the original text — replace the "unresolved" framing with the decision and a pointer.

- [ ] **Step 3: Commit**

```bash
git add apps/web/ARCHITECTURE.md docs/architecture/multi-tenant-data-model.md
git commit -m "docs(db): record submission uniqueness and restart semantics (#128)"
```

---

## Self-Review

**Spec coverage:**
- Data model (composite FK, unique, tutor-conversation exclusion) → Task 1.
- Restart semantics, graded guard, fail-closed soft-delete → Task 3.
- Atomicity / `runAtomically` → Task 2.
- Migration ordering and loud-failure-on-duplicates → Task 1 Step 4.
- Scope boundary (no route, no UI) → Global Constraints; enforced by the absence of any route task.
- Testing (real-DB reproduction, composite FK, mocked unit tests) → Tasks 1 and 3.
- **Deviation from spec:** the spec's "audit action" scope item is dropped. `AUDIT_ACTIONS.SUBMISSION_VOIDED` would have no writer until #27 exists, and an unused constant is dead code an audit will correctly flag. `restartSectionConversation` returns the voided submission so #27 can write the event and add the constant then. Recorded in Task 3's doc comment.

**Placeholder scan:** none — every step carries the actual SQL, TypeScript, or command.

**Type consistency:** `restartSectionConversation` returns `{ voidedSubmission: { id, submittedAt } | null }` in the Interfaces block, the test, the implementation, and Task 3 Step 5's real-DB case. `runAtomically(db, build)` matches between Task 2's implementation and Task 3's call site. `SubmissionGradedError` takes no constructor argument in both its definition and its test.
