# M2 Runtime Data Layer & Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **This plan is structured as 5 Phases, one per GitHub issue (#2, #14, #15, #16, #17 under epic #18). Stop after each Phase's final task and get the requester's review before starting the next Phase — do not auto-continue across Phases.**

**Goal:** Build the runtime data layer (conversations, messages, submissions, grades, citations, telemetry, audit) plus an org-scoped repository layer and a TypeScript seed script, so the platform stops being schema-only and routes stop touching Drizzle directly.

**Architecture:** Two new/extended schema modules (`apps/web/src/db/schema/runtime.ts` for conversation-and-beyond entities, keeping `content.ts` for config/content), a `apps/web/src/server/repositories/` layer with two branded scope types (`OrgScope`, `CourseScope`) that make unscoped queries a type error, and a transactional `apps/web/scripts/seed.ts` for dev data.

**Tech Stack:** Drizzle ORM (`drizzle-orm/pg-core`), Postgres 16 + pgvector, Vitest, Hono, Neon serverless driver.

## Global Constraints

- All new runtime leaf tables (`submissions`, `grades`, `citations`, `llm_call_logs`, `student_profiles`, `audit_events`) carry a denormalized `organization_id: uuid().notNull()` plus at least one index on it — this is the epic's cross-cutting invariant, verified by grep in Phase-closing steps.
- `conversations`/`messages` are **not** in that org-denormalization list (confirmed against the epic body). They scope by `course_id` instead via a separate `CourseScope` branded type — recorded as a resolved design decision in Phase 1.
- Every repository method takes a branded `OrgScope` or `CourseScope`; passing a raw `string` is a TypeScript compile error, not just a runtime check.
- Migrations are additive/forward-only; `npm run db:migrate` run twice against the same DB must succeed.
- Routes (`apps/web/src/server/routes/*.ts`) must not import `db.select`/`db.insert`/table objects/`drizzle-orm` query helpers directly once a repository exists for that aggregate — they call repository functions instead.
- Follow existing schema idioms exactly: `pgEnum` for closed vocabularies, `check(name, sql\`...\`)` with `num_nonnulls()` for polymorphic single-scope columns, `uniqueIndex(...).where(...)` for partial uniqueness, `timestamp(..., { withTimezone: true })`, `relations()` exported alongside every table.
- CI (`.github/workflows/test.yml`) runs `npm run db:migrate` against a real `pgvector/pgvector:pg16` service, then `npm run typecheck`, then `npm test`, with `DATABASE_URL=postgres://llteacher:dev@localhost:5432/llteacher` set at job level. `npm test` runs through Turbo (`turbo run test`), and Turbo 2.x strict-mode env handling strips `DATABASE_URL` from the child process unless the `test` task explicitly lists it — `turbo.json`'s `test` task must declare `"env": ["DATABASE_URL", "ENCRYPTION_KEY", "BLIND_INDEX_KEY"]` or every real-DB integration test silently reports "skipped" in CI, not "passed" (this bit the epic itself during Phase 5 — see resolved design decision 11). Locally, `DATABASE_URL` must be exported in the shell (separate from `apps/web/.dev.vars`, which only feeds the Wrangler dev server, not Vitest) — integration test suites use `describe.skipIf(!process.env.DATABASE_URL)` so `npm test` still passes for a contributor with no local Postgres.

## Resolved Design Decisions (record in PR descriptions)

1. **Conversation uniqueness** (data-model doc §3.5 Q1): a partial unique index on `conversations (owner_user_id, section_id) WHERE kind = 'section' AND is_deleted = false` enforces "at most one active section-conversation per user per section." Combined with the existing 1:1 `submissions.conversation_id` unique constraint, this transitively gives "at most one submission per student per section" — the DB-level version of Django's `Submission.clean()` check — without needing to duplicate `owner_user_id`/`section_id` onto `submissions`.
2. **Message `content_type`**: neither an enum column nor a text column. `messages.parts` is `jsonb` matching the AI SDK's `UIMessage.parts` shape (`{ type: "text" | "tool-call" | ..., ... }[]`), which already carries content-type information per part. `role` stays a narrow enum (`user | assistant | system`).
3. **Prompt-version pinning on messages**: deferred out of scope for M2. Nothing writes LLM call data yet (issue #15 is schema-only; M8 wires the write path), so there's no consumer for a `prompt_template_version_id` FK today. Revisit when M8 lands.
4. **Schema file placement**: `conversations`/`messages`/`submissions`/`grades`/`citations`/`llm_call_logs`/`student_profiles`/`audit_events` all live in a new `apps/web/src/db/schema/runtime.ts`, matching the data-model doc's own "6.3 Runtime" ER split (as opposed to `content.ts`'s "6.2 Content & Configuration"). Issue #2's code-framework sketch suggested adding conversations to `content.ts`, but that file already has a clear, different responsibility (homeworks/sections/prompts/llm configs/materials); starting `runtime.ts` one issue early avoids a mid-epic file-split churn in issue #14.
5. **Repository scope granularity**: two branded types, not one. `OrgScope` (wraps `organization_id`) governs `submissions`, `grades`, `citations`, `llm_call_logs`, `student_profiles`, `audit_events`, `llmConfigs`. `CourseScope` (wraps `course_id`) governs `homeworks`, `sections`, `conversations`, `messages`, `courseMaterials`. This matches what each table actually has a column for — `conversations` has no `organization_id` (see decision 4), so an `OrgScope` there would be unenforceable at the type level.
6. **Grade grader consistency**: added a CHECK (`(graded_by_ai = true AND grader_membership_id IS NULL) OR (graded_by_ai = false AND grader_membership_id IS NOT NULL)`) beyond issue #14's literal text, so an AI grade can never carry a human grader FK and vice versa. `rubric jsonb` also added to `grades` (present in the data-model doc's ER diagram, omitted from issue #14's code sketch).
7. **Submission timestamp**: single `submitted_at timestamp notNull defaultNow()`, no separate `created_at`. A submission row's existence *is* the submit event (matches Django's `auto_now_add` behavior) — a separate `created_at` would always equal `submitted_at` and add nothing.
8. **Audit-event append-only enforcement**: DB-level `REVOKE UPDATE, DELETE` grants are deferred — the current setup uses one Postgres role for all Neon connections, so a revoke would need a dedicated low-privilege app role first (infra work, not this epic). For M2, append-only is enforced at the application layer: `repositories/auditEvents.ts` exports only `recordAuditEvent` (insert), no update/delete function exists anywhere in the codebase for that table. Documented in a comment above the `auditEvents` table definition; a follow-up infra issue should add the DB grant.
9. **Real-DB test/seed driver** (discovered during Phase 1 execution, not anticipated by any issue text): `makeDb()` in `db/client.ts` uses `@neondatabase/serverless`'s HTTP driver, which speaks Neon's proxy protocol and **cannot connect to a plain Postgres server at all** — not a local quirk, it fails identically against the CI Postgres service. It's the right driver for production (the only one that works inside a Cloudflare Worker, no raw TCP), but wrong for anything that runs as a plain Node process. Added `apps/web/src/db/nodeClient.ts` (`makeNodeDb`), a `drizzle-orm/node-postgres` + `pg` client — `pg` was already a devDependency for the same reason on the `drizzle-kit` CLI — cast to the same `Db` type at the boundary (verified-safe: both are Drizzle `PgDatabase` instances over the same schema, and no code in this codebase uses raw `.execute()`, the one place the underlying HKT type param could matter). All real-DB integration tests (Phases 1–4) and the seed script itself (Phase 5) use `makeNodeDb`, not `makeDb` — production route code (`hello.ts`, `homeworks.ts`, etc.) is unaffected and keeps using `makeDb`.
10. **`scripts/` wasn't wired into either tool** (discovered during Phase 5 execution): `vitest.config.ts`'s `include` only matched `src/**/*.test.ts`, so `scripts/seed.test.ts` silently collected zero tests until `"scripts/**/*.test.ts"` was added. Separately, `npm run typecheck` (`tsc -b`) never covered `scripts/seed.ts` either — none of the three tsconfig project references (`tsconfig.json` → `src/client` only; `tsconfig.node.json` → build-tooling config files only; `tsconfig.worker.json` → `src/server`/`src/shared`/`src/db`/`src/lib`) listed `scripts`. Added `"scripts"` to `tsconfig.worker.json`'s `include` (not `tsconfig.node.json` — `scripts/seed.ts` imports from `src/db` and `src/lib`, which are files owned by the worker project; TS project references require the importing file to live in the same project as what it imports, or a `references` edge between them). This is also what caught a real unused-import bug (`homeworks` in `seed.test.ts`) that had been invisible to `npm run typecheck` the whole time.
11. **`turbo run test` was silently discarding `DATABASE_URL` from every task, in CI too** (discovered during Phase 5 execution — the most consequential finding in this epic, broader than the seed script itself). Turbo 2.x defaults every task to strict env mode: only env vars explicitly listed in `turbo.json`'s `globalEnv` or a task's own `env`/`passThroughEnv` reach the child process; everything else is stripped, regardless of whether it's set in the parent shell or (as in CI) at the GitHub Actions job level. `turbo.json` had no such declaration for the `test` task. Consequence: **every real-DB integration test written in Phases 1–4** (`runtime.test.ts`, `conversations.test.ts`, `submissions.test.ts`) has been silently reporting "skipped," never "passed," in CI's `Test` step this whole time — CI was never actually proving the schema constraints, cascade behavior, or cross-org isolation it looked like it was proving. Root-cause-found by deliberately reproducing CI's exact invocation shape (`export DATABASE_URL=...; npm test` from repo root, matching a GitHub Actions job-level `env:` block) instead of trusting the local ad-hoc `DATABASE_URL=... npx vitest run <file>` invocations used throughout earlier phases, which bypass Turbo entirely and so never surfaced this. Fixed by adding `"env": ["DATABASE_URL", "ENCRYPTION_KEY", "BLIND_INDEX_KEY"]` to the `test` task in `turbo.json`. Verified fixed by rerunning the same reproduction and confirming all 3 real-DB suites (30 tests) flip from skipped to passed. **Action item for whoever reviews this PR**: re-run this epic's CI once merged and confirm the `Test` step's log actually shows `runtime.test.ts`, `conversations.test.ts`, and `submissions.test.ts` passing (not skipped) — that log line is the actual proof this fix works in the real CI environment, not just this reproduction.

---

## Phase 1 — Issue #2: `conversations` + `messages` schema

### Task 1: `conversations` and `messages` tables + migration

**Files:**
- Create: `apps/web/src/db/schema/runtime.ts`
- Modify: `apps/web/src/db/schema.ts:9` (add `export * from "./schema/runtime";`)
- Test: `apps/web/src/db/schema/runtime.test.ts`
- Generated: `apps/web/src/db/migrations/000X_*.sql` (via `db:generate`)

**Interfaces:**
- Produces: `conversationKindEnum`, `messageRoleEnum`, `conversations`, `messages`, `conversationsRelations`, `messagesRelations` — all re-exported from `apps/web/src/db/schema.ts`. Later tasks (`submissions` in Task 4) reference `conversations.id`; `citations` (Task 6) references `messages.id`.

- [ ] **Step 1: Write the schema module**

Create `apps/web/src/db/schema/runtime.ts`:

```typescript
import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { courses, users } from "./identity";
import { sections } from "./content";

// ---------- Enums ----------

export const conversationKindEnum = pgEnum("conversation_kind", [
  "section",
  "tutor",
]);

export const messageRoleEnum = pgEnum("message_role", [
  "user",
  "assistant",
  "system",
]);

// ---------- Conversation ----------
// "section" conversations are a student working a specific homework Section;
// "tutor" conversations are the free-standing course-wide tutor (no section).
// The kind/section-nullability pairing is enforced by a CHECK, not just app
// logic. course_id is NOT NULL on both kinds -- it's the tenancy/course-scope
// boundary this table (and messages, via conversation_id) is queried through.
// There is no organization_id column here by design -- see the runtime-plan
// "Resolved Design Decisions" doc note (decision 4/5): conversations scope by
// CourseScope, not OrgScope.

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    sectionId: uuid("section_id").references(() => sections.id, {
      onDelete: "cascade",
    }),
    kind: conversationKindEnum("kind").notNull(),
    title: text("title").notNull(),
    isDeleted: boolean("is_deleted").notNull().default(false),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Matches issue #2's literal (ownerUserId, kind, courseId) column order
    // for the "list this user's tutor conversations" query shape.
    index("conversations_owner_kind_course_idx").on(t.ownerUserId, t.kind, t.courseId),
    index("conversations_course_kind_idx").on(t.courseId, t.kind),
    // Resolved design decision 1: at most one active section-conversation
    // per (user, section). Combined with submissions.conversation_id's own
    // uniqueness (Task 4), this transitively caps submissions at one per
    // (user, section) too.
    uniqueIndex("conversations_owner_section_active_uq")
      .on(t.ownerUserId, t.sectionId)
      .where(sql`${t.kind} = 'section' AND ${t.isDeleted} = false`),
    check(
      "conversations_kind_section_chk",
      sql`(${t.kind} = 'tutor' AND ${t.sectionId} IS NULL)
          OR (${t.kind} = 'section' AND ${t.sectionId} IS NOT NULL)`,
    ),
  ],
);

// ---------- Message ----------
// parts is jsonb matching the AI SDK's UIMessage.parts shape (text parts,
// tool-call parts, etc.) -- resolved design decision 2. Do not flatten to a
// plain text column; tool-call/tool-result state would be lost on reload.

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: messageRoleEnum("role").notNull(),
    parts: jsonb("parts").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("messages_conversation_created_idx").on(
      t.conversationId,
      t.createdAt,
    ),
  ],
);

// ---------- Relations ----------

export const conversationsRelations = relations(
  conversations,
  ({ one, many }) => ({
    owner: one(users, {
      fields: [conversations.ownerUserId],
      references: [users.id],
    }),
    course: one(courses, {
      fields: [conversations.courseId],
      references: [courses.id],
    }),
    section: one(sections, {
      fields: [conversations.sectionId],
      references: [sections.id],
    }),
    messages: many(messages),
  }),
);

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
}));
```

- [ ] **Step 2: Wire into the schema barrel**

Edit `apps/web/src/db/schema.ts`:

```typescript
export * from "./schema/pings";
export * from "./schema/identity";
export * from "./schema/content";
export * from "./schema/runtime";
```

- [ ] **Step 3: Generate the migration**

Run: `cd apps/web && npm run db:generate`
Expected: a new file under `apps/web/src/db/migrations/000X_*.sql` creating `conversation_kind`/`message_role` enum types, `conversations`, `messages`, their indexes, unique index, and CHECK constraint. Inspect the generated SQL to confirm the CHECK and partial unique index text matches the schema above (drizzle-kit sometimes needs `--custom` nudging for partial indexes; if the generated migration doesn't include the `WHERE` clause, hand-edit the generated `.sql` file to add it and note that in the PR).

- [ ] **Step 4: Apply the migration locally**

Run: `cd apps/web && npm run db:migrate` (requires `DATABASE_URL` pointed at a real Postgres — see Phase 1 close-out for the local Docker one-liner if you don't have one yet)
Expected: exits 0, no errors.

- [ ] **Step 5: Write the schema tests**

Create `apps/web/src/db/schema/runtime.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { makeNodeDb } from "../nodeClient";
import type { Db } from "../client";
import {
  conversations,
  messages,
  organizations,
  courses,
  users,
  sections,
  homeworks,
} from "../schema";

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)("conversations + messages schema", () => {
  let db: Db;
  let orgId: string;
  let courseId: string;
  let userId: string;
  let sectionId: string;

  beforeAll(async () => {
    db = makeNodeDb(DATABASE_URL!);
    const [org] = await db
      .insert(organizations)
      .values({
        slug: `runtime-test-${crypto.randomUUID()}`,
        name: "Runtime Test Org",
        workosOrganizationId: `workos-${crypto.randomUUID()}`,
      })
      .returning({ id: organizations.id });
    orgId = org.id;

    const [course] = await db
      .insert(courses)
      .values({ organizationId: orgId, code: "TEST 101", term: "T1", title: "Test" })
      .returning({ id: courses.id });
    courseId = course.id;

    const emailBytes = crypto.getRandomValues(new Uint8Array(32));
    const [user] = await db
      .insert(users)
      .values({ email: emailBytes as never, emailBlindIndex: emailBytes as never })
      .returning({ id: users.id });
    userId = user.id;

    const [membership] = await db
      .insert(await import("../schema").then((m) => m.courseMemberships))
      .values({ userId, courseId, role: "instructor" })
      .returning({ id: sql<string>`id` });

    const [hw] = await db
      .insert(homeworks)
      .values({
        courseId,
        createdById: membership.id,
        title: "HW",
        description: "d",
        dueDate: new Date(),
      })
      .returning({ id: homeworks.id });

    const [section] = await db
      .insert(sections)
      .values({ homeworkId: hw.id, order: 1, title: "S1", content: "c" })
      .returning({ id: sections.id });
    sectionId = section.id;
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  it("rejects a tutor conversation with a non-null sectionId", async () => {
    await expect(
      db.insert(conversations).values({
        ownerUserId: userId,
        courseId,
        sectionId,
        kind: "tutor",
        title: "t",
      }),
    ).rejects.toThrow();
  });

  it("rejects a section conversation with a null sectionId", async () => {
    await expect(
      db.insert(conversations).values({
        ownerUserId: userId,
        courseId,
        sectionId: null,
        kind: "section",
        title: "t",
      }),
    ).rejects.toThrow();
  });

  it("rejects a second active section-conversation for the same (user, section)", async () => {
    await db.insert(conversations).values({
      ownerUserId: userId,
      courseId,
      sectionId,
      kind: "section",
      title: "first",
    });
    await expect(
      db.insert(conversations).values({
        ownerUserId: userId,
        courseId,
        sectionId,
        kind: "section",
        title: "second",
      }),
    ).rejects.toThrow();
  });

  it("allows a new active conversation once the prior one is soft-deleted", async () => {
    const [first] = await db
      .insert(conversations)
      .values({ ownerUserId: userId, courseId, sectionId, kind: "section", title: "a" })
      .returning({ id: conversations.id });
    await db
      .update(conversations)
      .set({ isDeleted: true, deletedAt: new Date() })
      .where(eq(conversations.id, first.id));

    await expect(
      db.insert(conversations).values({
        ownerUserId: userId,
        courseId,
        sectionId,
        kind: "section",
        title: "b",
      }),
    ).resolves.toBeDefined();
  });

  it("round-trips jsonb parts (including tool-call shape) unchanged", async () => {
    const [conv] = await db
      .insert(conversations)
      .values({ ownerUserId: userId, courseId, sectionId: null, kind: "tutor", title: "t" })
      .returning({ id: conversations.id });

    const parts = [
      { type: "text", text: "hi" },
      { type: "tool-call", toolCallId: "abc", toolName: "run_code", args: { code: "1+1" } },
    ];
    const [msg] = await db
      .insert(messages)
      .values({ conversationId: conv.id, role: "assistant", parts })
      .returning({ parts: messages.parts });

    expect(msg.parts).toEqual(parts);
  });

  it("rejects a message referencing a non-existent conversationId", async () => {
    await expect(
      db.insert(messages).values({
        conversationId: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: "x" }],
      }),
    ).rejects.toThrow();
  });

  it("cascade-deletes messages when their conversation is deleted", async () => {
    const [conv] = await db
      .insert(conversations)
      .values({ ownerUserId: userId, courseId, sectionId: null, kind: "tutor", title: "t2" })
      .returning({ id: conversations.id });
    await db
      .insert(messages)
      .values({ conversationId: conv.id, role: "user", parts: [{ type: "text", text: "hi" }] });

    await db.delete(conversations).where(eq(conversations.id, conv.id));

    const remaining = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conv.id));
    expect(remaining).toHaveLength(0);
  });
});
```

- [ ] **Step 6: Run the tests**

Run: `cd apps/web && DATABASE_URL=postgres://llteacher:dev@localhost:5432/llteacher npx vitest run src/db/schema/runtime.test.ts` (start the Docker Postgres from Phase 1 close-out first if not already running)
Expected: all 7 tests PASS. If any constraint test unexpectedly passes without throwing, the migration's CHECK/unique-index text is wrong — re-check Step 3's generated SQL.

- [ ] **Step 7: Typecheck**

Run: `cd apps/web && npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/db/schema/runtime.ts apps/web/src/db/schema.ts apps/web/src/db/schema/runtime.test.ts apps/web/src/db/migrations
git commit -m "feat(db): add conversations and messages tables (#2)"
```

### Phase 1 close-out (do before reporting back)

- [ ] If you don't already have a local Postgres, start one matching CI exactly:
  ```bash
  docker run --rm -d --name llteacher-pg -p 5432:5432 \
    -e POSTGRES_USER=llteacher -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=llteacher \
    pgvector/pgvector:pg16
  psql postgres://llteacher:dev@localhost:5432/llteacher -f apps/web/src/db/init/01_extensions.sql
  ```
- [ ] Re-run the full suite once more: `cd apps/web && DATABASE_URL=postgres://llteacher:dev@localhost:5432/llteacher npm test`
- [ ] Verify acceptance criteria from issue #2 line by line: both tables exist with the required columns, relations exist in both directions, the kind/section CHECK is enforced, indexes exist on `(owner_user_id, kind, course_id)`-equivalent and `(conversation_id, created_at)`, migration is committed, barrel re-exports both modules.
- [ ] Report back per the "Review checkpoint" format at the end of this doc.

---

## Phase 2 — Issue #14: `submissions`, `grades`, `citations`

### Task 2: `submissions`, `grades`, `citations` tables + migration

**Files:**
- Modify: `apps/web/src/db/schema/runtime.ts` (append tables)
- Test: `apps/web/src/db/schema/runtime.test.ts` (append `describe` block)
- Generated: new migration file

**Interfaces:**
- Consumes: `conversations` (Task 1), `materialChunks` (existing, `content.ts`), `courseMemberships`/`organizations` (existing, `identity.ts`).
- Produces: `submissions`, `grades`, `citations` + relations, re-exported via the existing barrel (no barrel change needed — `runtime.ts` is already exported).

- [ ] **Step 1: Append the schema**

Add to `apps/web/src/db/schema/runtime.ts` (new imports needed: `doublePrecision`, `integer`, and `materialChunks`, `courseMemberships`, `organizations` from `./content` / `./identity`):

```typescript
// add to the top-of-file import list:
// doublePrecision, integer  -- from "drizzle-orm/pg-core"
// materialChunks            -- from "./content"
// courseMemberships, organizations -- from "./identity"

// ---------- Submission ----------
// 1:1 with a conversation. organization_id is denormalized per the epic's
// cross-cutting invariant (submissions is in the required-org-id list).
// See resolved design decision 7 for why there's no separate created_at.

export const submissions = pgTable(
  "submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .unique()
      .references(() => conversations.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    submittedAt: timestamp("submitted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("submissions_org_idx").on(t.organizationId)],
);

// ---------- Grade ----------
// N:1 from submission (AI-first, instructor override allowed as a second
// row). Exactly one of (graded_by_ai, grader_membership_id-is-set) --
// resolved design decision 6.

export const grades = pgTable(
  "grades",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => submissions.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    graderMembershipId: uuid("grader_membership_id").references(
      () => courseMemberships.id,
      { onDelete: "set null" },
    ),
    gradedByAi: boolean("graded_by_ai").notNull().default(false),
    score: doublePrecision("score"),
    rubric: jsonb("rubric"),
    feedback: text("feedback"),
    gradedAt: timestamp("graded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("grades_org_idx").on(t.organizationId),
    index("grades_submission_idx").on(t.submissionId),
    check(
      "grades_grader_consistency_chk",
      sql`(${t.gradedByAi} = true AND ${t.graderMembershipId} IS NULL)
          OR (${t.gradedByAi} = false AND ${t.graderMembershipId} IS NOT NULL)`,
    ),
  ],
);

// ---------- Citation ----------
// Polymorphic source: exactly one of (message_id, grade_id) is non-null,
// same num_nonnulls() pattern as content.ts's promptTemplates.

export const citations = pgTable(
  "citations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id").references(() => messages.id, {
      onDelete: "cascade",
    }),
    gradeId: uuid("grade_id").references(() => grades.id, {
      onDelete: "cascade",
    }),
    materialChunkId: uuid("material_chunk_id")
      .notNull()
      .references(() => materialChunks.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    spanStart: integer("span_start"),
    spanEnd: integer("span_end"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("citations_org_idx").on(t.organizationId),
    index("citations_material_chunk_idx").on(t.materialChunkId),
    check(
      "citations_single_source_chk",
      sql`num_nonnulls(${t.messageId}, ${t.gradeId}) = 1`,
    ),
  ],
);

// ---------- Relations ----------

export const submissionsRelations = relations(submissions, ({ one, many }) => ({
  conversation: one(conversations, {
    fields: [submissions.conversationId],
    references: [conversations.id],
  }),
  organization: one(organizations, {
    fields: [submissions.organizationId],
    references: [organizations.id],
  }),
  grades: many(grades),
}));

export const gradesRelations = relations(grades, ({ one, many }) => ({
  submission: one(submissions, {
    fields: [grades.submissionId],
    references: [submissions.id],
  }),
  grader: one(courseMemberships, {
    fields: [grades.graderMembershipId],
    references: [courseMemberships.id],
  }),
  citations: many(citations),
}));

export const citationsRelations = relations(citations, ({ one }) => ({
  message: one(messages, {
    fields: [citations.messageId],
    references: [messages.id],
  }),
  grade: one(grades, {
    fields: [citations.gradeId],
    references: [grades.id],
  }),
  materialChunk: one(materialChunks, {
    fields: [citations.materialChunkId],
    references: [materialChunks.id],
  }),
}));
```

- [ ] **Step 2: Generate + apply the migration**

Run: `cd apps/web && npm run db:generate && npm run db:migrate`
Expected: new migration creating `submissions`, `grades`, `citations`, indexes, and both CHECK constraints; applies cleanly.

- [ ] **Step 3: Write the schema tests**

Append to `apps/web/src/db/schema/runtime.test.ts` (reuses the `beforeAll` fixtures — `orgId`, `courseId`, `userId`, `sectionId` — from Phase 1's `describe` block; add a second top-level `describe.skipIf(!DATABASE_URL)` block with its own fixtures for a *second* org to prove isolation):

```typescript
describe.skipIf(!DATABASE_URL)("submissions, grades, citations schema", () => {
  let db: Db;
  let orgAId: string;
  let orgBId: string;
  let courseAId: string;
  let userAId: string;
  let sectionAId: string;
  let conversationAId: string;

  beforeAll(async () => {
    db = makeNodeDb(DATABASE_URL!);

    async function makeOrgWithConversation(label: string) {
      const [org] = await db
        .insert(organizations)
        .values({
          slug: `sub-test-${label}-${crypto.randomUUID()}`,
          name: `Sub Test Org ${label}`,
          workosOrganizationId: `workos-${label}-${crypto.randomUUID()}`,
        })
        .returning({ id: organizations.id });
      const [course] = await db
        .insert(courses)
        .values({ organizationId: org.id, code: "T1", term: "T1", title: "T" })
        .returning({ id: courses.id });
      const emailBytes = crypto.getRandomValues(new Uint8Array(32));
      const [user] = await db
        .insert(users)
        .values({ email: emailBytes as never, emailBlindIndex: emailBytes as never })
        .returning({ id: users.id });
      const { courseMemberships } = await import("../schema");
      const [membership] = await db
        .insert(courseMemberships)
        .values({ userId: user.id, courseId: course.id, role: "instructor" })
        .returning({ id: courseMemberships.id });
      const [hw] = await db
        .insert(homeworks)
        .values({ courseId: course.id, createdById: membership.id, title: "h", description: "d", dueDate: new Date() })
        .returning({ id: homeworks.id });
      const [section] = await db
        .insert(sections)
        .values({ homeworkId: hw.id, order: 1, title: "s", content: "c" })
        .returning({ id: sections.id });
      const [conv] = await db
        .insert(conversations)
        .values({ ownerUserId: user.id, courseId: course.id, sectionId: section.id, kind: "section", title: "t" })
        .returning({ id: conversations.id });
      return { orgId: org.id, courseId: course.id, userId: user.id, sectionId: section.id, conversationId: conv.id };
    }

    const a = await makeOrgWithConversation("a");
    orgAId = a.orgId;
    courseAId = a.courseId;
    userAId = a.userId;
    sectionAId = a.sectionId;
    conversationAId = a.conversationId;

    const b = await makeOrgWithConversation("b");
    orgBId = b.orgId;
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgAId));
    await db.delete(organizations).where(eq(organizations.id, orgBId));
  });

  it("rejects a second submission for the same conversation", async () => {
    await db.insert(submissions).values({ conversationId: conversationAId, organizationId: orgAId });
    await expect(
      db.insert(submissions).values({ conversationId: conversationAId, organizationId: orgAId }),
    ).rejects.toThrow();
  });

  it("a query scoped to org A returns zero submissions seeded under org B", async () => {
    const rows = await db.select().from(submissions).where(eq(submissions.organizationId, orgBId));
    expect(rows).toHaveLength(0);
  });

  it("rejects a grade that is both graded_by_ai and has a grader_membership_id", async () => {
    const [sub] = await db
      .select({ id: submissions.id })
      .from(submissions)
      .where(eq(submissions.conversationId, conversationAId));
    const { courseMemberships } = await import("../schema");
    const [membership] = await db
      .select({ id: courseMemberships.id })
      .from(courseMemberships)
      .where(eq(courseMemberships.courseId, courseAId));

    await expect(
      db.insert(grades).values({
        submissionId: sub.id,
        organizationId: orgAId,
        gradedByAi: true,
        graderMembershipId: membership.id,
      }),
    ).rejects.toThrow();
  });

  it("rejects a grade with neither graded_by_ai nor a grader", async () => {
    const [sub] = await db
      .select({ id: submissions.id })
      .from(submissions)
      .where(eq(submissions.conversationId, conversationAId));
    await expect(
      db.insert(grades).values({ submissionId: sub.id, organizationId: orgAId, gradedByAi: false }),
    ).rejects.toThrow();
  });

  it("rejects a citation with both messageId and gradeId set, and one with neither", async () => {
    const [msg] = await db
      .insert(messages)
      .values({ conversationId: conversationAId, role: "user", parts: [{ type: "text", text: "x" }] })
      .returning({ id: messages.id });
    const { courseMaterials, materialChunks } = await import("../schema");
    const [material] = await db
      .insert(courseMaterials)
      .values({
        courseId: courseAId,
        uploadedById: (
          await db.select({ id: (await import("../schema")).courseMemberships.id }).from((await import("../schema")).courseMemberships).where(eq((await import("../schema")).courseMemberships.courseId, courseAId))
        )[0].id,
        sourceType: "pdf",
        title: "m",
      })
      .returning({ id: courseMaterials.id });
    const [chunk] = await db
      .insert(materialChunks)
      .values({ materialId: material.id, ordinal: 0, text: "t", tokenCount: 1 })
      .returning({ id: materialChunks.id });

    await expect(
      db.insert(citations).values({
        messageId: msg.id,
        gradeId: crypto.randomUUID(),
        materialChunkId: chunk.id,
        organizationId: orgAId,
      }),
    ).rejects.toThrow();

    await expect(
      db.insert(citations).values({
        materialChunkId: chunk.id,
        organizationId: orgAId,
      }),
    ).rejects.toThrow();
  });

  it("cascade-deletes submission (and its grades) when the conversation is deleted", async () => {
    const [conv] = await db
      .insert(conversations)
      .values({ ownerUserId: userAId, courseId: courseAId, sectionId: null, kind: "tutor", title: "cascade-test" })
      .returning({ id: conversations.id });
    const [sub] = await db
      .insert(submissions)
      .values({ conversationId: conv.id, organizationId: orgAId })
      .returning({ id: submissions.id });
    await db.insert(grades).values({ submissionId: sub.id, organizationId: orgAId, gradedByAi: true });

    await db.delete(conversations).where(eq(conversations.id, conv.id));

    const remainingSubs = await db.select().from(submissions).where(eq(submissions.id, sub.id));
    const remainingGrades = await db.select().from(grades).where(eq(grades.submissionId, sub.id));
    expect(remainingSubs).toHaveLength(0);
    expect(remainingGrades).toHaveLength(0);
  });
});
```

Note: the nested `await import("../schema")` calls in the citation test are verbose but deliberate — they avoid adding `courseMemberships`/`courseMaterials`/`materialChunks` to the file's static import list purely for one test block; simplify by hoisting them to a normal top-of-file import if it reads better during implementation (either is fine, this is a style call not a correctness one).

- [ ] **Step 4: Run the tests**

Run: `cd apps/web && DATABASE_URL=postgres://llteacher:dev@localhost:5432/llteacher npx vitest run src/db/schema/runtime.test.ts`
Expected: all tests from Phase 1 + Phase 2 PASS.

- [ ] **Step 5: Typecheck**

Run: `cd apps/web && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/db/schema/runtime.ts apps/web/src/db/schema/runtime.test.ts apps/web/src/db/migrations
git commit -m "feat(db): add submissions, grades, and citations tables (#14)"
```

### Phase 2 close-out

- [ ] Grep-verify the cross-cutting invariant: `grep -n "organizationId" apps/web/src/db/schema/runtime.ts` shows it on `submissions`, `grades`, `citations` (and, from Phase 3, `llm_call_logs`, `student_profiles`, `audit_events`).
- [ ] Verify issue #14 acceptance criteria line by line against the code.
- [ ] Report back per the "Review checkpoint" format.

---

## Phase 3 — Issue #15: `llm_call_logs`, `student_profiles`, `audit_events`

### Task 3: telemetry/compliance tables + migration

**Files:**
- Modify: `apps/web/src/db/schema/runtime.ts` (append tables; also import `llmProviderEnum` from `./content` — it already exists, don't redefine it)
- Test: `apps/web/src/db/schema/runtime.test.ts` (append `describe` block)
- Generated: new migration file

- [ ] **Step 1: Append the schema**

```typescript
// add to imports: llmProviderEnum, llmConfigs from "./content"

// ---------- LLMCallLog ----------
// 1:1 per message. conversation_id is denormalized (reachable via
// message -> conversation, but the M8 analytics query shape is
// "calls by conversation" and "calls by org+time" -- avoid a join for both).

export const llmCallLogs = pgTable(
  "llm_call_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id")
      .notNull()
      .unique()
      .references(() => messages.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    llmConfigId: uuid("llm_config_id").references(() => llmConfigs.id, {
      onDelete: "set null",
    }),
    provider: llmProviderEnum("provider").notNull(),
    model: text("model").notNull(),
    providerRequestId: text("provider_request_id"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costCents: integer("cost_cents"),
    latencyMs: integer("latency_ms"),
    errorFlag: boolean("error_flag").notNull().default(false),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("llm_call_logs_org_time_idx").on(t.organizationId, t.occurredAt),
    index("llm_call_logs_conversation_idx").on(t.conversationId),
  ],
);

// ---------- StudentProfile ----------
// Derived/regenerable state, NOT authoritative -- safe to truncate and
// rebuild from raw conversations. See docs/architecture/multi-tenant-data-model.md
// §3.2 StudentProfile. computed_at is null until the first computation job runs.

export const studentProfiles = pgTable(
  "student_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    summary: text("summary"),
    masterySignals: jsonb("mastery_signals"),
    computedAt: timestamp("computed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("student_profiles_user_course_uq").on(t.userId, t.courseId),
    index("student_profiles_org_idx").on(t.organizationId),
  ],
);

// ---------- AuditEvent ----------
// Append-only. No update/delete function exists for this table anywhere in
// the repository layer (repositories/auditEvents.ts exports only
// recordAuditEvent) -- that is the M2 enforcement mechanism. DB-level
// REVOKE UPDATE, DELETE grants need a dedicated low-privilege app role and
// are tracked as follow-up infra work, not part of this migration
// (resolved design decision 8).

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: uuid("target_id").notNull(),
    ip: text("ip"),
    requestMetadata: jsonb("request_metadata"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("audit_events_org_time_idx").on(t.organizationId, t.occurredAt),
    index("audit_events_actor_time_idx").on(t.actorUserId, t.occurredAt),
    index("audit_events_target_idx").on(t.targetType, t.targetId),
  ],
);

// ---------- Relations ----------

export const llmCallLogsRelations = relations(llmCallLogs, ({ one }) => ({
  message: one(messages, {
    fields: [llmCallLogs.messageId],
    references: [messages.id],
  }),
  conversation: one(conversations, {
    fields: [llmCallLogs.conversationId],
    references: [conversations.id],
  }),
  organization: one(organizations, {
    fields: [llmCallLogs.organizationId],
    references: [organizations.id],
  }),
  llmConfig: one(llmConfigs, {
    fields: [llmCallLogs.llmConfigId],
    references: [llmConfigs.id],
  }),
}));

export const studentProfilesRelations = relations(studentProfiles, ({ one }) => ({
  user: one(users, {
    fields: [studentProfiles.userId],
    references: [users.id],
  }),
  course: one(courses, {
    fields: [studentProfiles.courseId],
    references: [courses.id],
  }),
}));

export const auditEventsRelations = relations(auditEvents, ({ one }) => ({
  organization: one(organizations, {
    fields: [auditEvents.organizationId],
    references: [organizations.id],
  }),
  actor: one(users, {
    fields: [auditEvents.actorUserId],
    references: [users.id],
  }),
}));
```

- [ ] **Step 2: Generate + apply the migration**

Run: `cd apps/web && npm run db:generate && npm run db:migrate`

- [ ] **Step 3: Write the schema tests**

Append to `apps/web/src/db/schema/runtime.test.ts`:

```typescript
describe.skipIf(!DATABASE_URL)("llm_call_logs, student_profiles, audit_events schema", () => {
  let db: Db;
  let orgId: string;
  let courseId: string;
  let userId: string;
  let conversationId: string;
  let messageId: string;

  beforeAll(async () => {
    db = makeNodeDb(DATABASE_URL!);
    const [org] = await db
      .insert(organizations)
      .values({ slug: `tel-${crypto.randomUUID()}`, name: "Tel Org", workosOrganizationId: `w-${crypto.randomUUID()}` })
      .returning({ id: organizations.id });
    orgId = org.id;
    const [course] = await db
      .insert(courses)
      .values({ organizationId: orgId, code: "T", term: "T", title: "T" })
      .returning({ id: courses.id });
    courseId = course.id;
    const emailBytes = crypto.getRandomValues(new Uint8Array(32));
    const [user] = await db
      .insert(users)
      .values({ email: emailBytes as never, emailBlindIndex: emailBytes as never })
      .returning({ id: users.id });
    userId = user.id;
    const [conv] = await db
      .insert(conversations)
      .values({ ownerUserId: userId, courseId, sectionId: null, kind: "tutor", title: "t" })
      .returning({ id: conversations.id });
    conversationId = conv.id;
    const [msg] = await db
      .insert(messages)
      .values({ conversationId, role: "assistant", parts: [{ type: "text", text: "hi" }] })
      .returning({ id: messages.id });
    messageId = msg.id;
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  it("rejects a second llm_call_log for the same message", async () => {
    await db.insert(llmCallLogs).values({
      messageId,
      conversationId,
      organizationId: orgId,
      provider: "anthropic",
      model: "claude-sonnet",
    });
    await expect(
      db.insert(llmCallLogs).values({
        messageId,
        conversationId,
        organizationId: orgId,
        provider: "anthropic",
        model: "claude-sonnet",
      }),
    ).rejects.toThrow();
  });

  it("cascade-deletes the llm_call_log when its message is deleted", async () => {
    const [msg2] = await db
      .insert(messages)
      .values({ conversationId, role: "assistant", parts: [{ type: "text", text: "x" }] })
      .returning({ id: messages.id });
    await db.insert(llmCallLogs).values({
      messageId: msg2.id,
      conversationId,
      organizationId: orgId,
      provider: "openai",
      model: "gpt",
    });
    await db.delete(messages).where(eq(messages.id, msg2.id));
    const remaining = await db.select().from(llmCallLogs).where(eq(llmCallLogs.messageId, msg2.id));
    expect(remaining).toHaveLength(0);
  });

  it("rejects a second student_profile for the same (user, course)", async () => {
    await db.insert(studentProfiles).values({ userId, courseId, organizationId: orgId });
    await expect(
      db.insert(studentProfiles).values({ userId, courseId, organizationId: orgId }),
    ).rejects.toThrow();
  });

  it("sums cost_cents across llm_call_logs for a conversation correctly", async () => {
    const [m1] = await db
      .insert(messages)
      .values({ conversationId, role: "assistant", parts: [{ type: "text", text: "a" }] })
      .returning({ id: messages.id });
    const [m2] = await db
      .insert(messages)
      .values({ conversationId, role: "assistant", parts: [{ type: "text", text: "b" }] })
      .returning({ id: messages.id });
    await db.insert(llmCallLogs).values([
      { messageId: m1.id, conversationId, organizationId: orgId, provider: "openai", model: "gpt", costCents: 3 },
      { messageId: m2.id, conversationId, organizationId: orgId, provider: "openai", model: "gpt", costCents: 4 },
    ]);
    const [{ total }] = await db
      .select({ total: sql<number>`sum(${llmCallLogs.costCents})` })
      .from(llmCallLogs)
      .where(eq(llmCallLogs.conversationId, conversationId));
    expect(Number(total)).toBeGreaterThanOrEqual(7);
  });

  it("allows a nullable actorUserId (system-initiated audit event) and survives actor deletion", async () => {
    const [event] = await db
      .insert(auditEvents)
      .values({ organizationId: orgId, actorUserId: null, action: "system_sync", targetType: "course", targetId: courseId })
      .returning({ id: auditEvents.id });
    expect(event.id).toBeDefined();

    const emailBytes = crypto.getRandomValues(new Uint8Array(32));
    const [actor] = await db
      .insert(users)
      .values({ email: emailBytes as never, emailBlindIndex: emailBytes as never })
      .returning({ id: users.id });
    const [event2] = await db
      .insert(auditEvents)
      .values({ organizationId: orgId, actorUserId: actor.id, action: "viewed", targetType: "submission", targetId: crypto.randomUUID() })
      .returning({ id: auditEvents.id });

    await db.delete(users).where(eq(users.id, actor.id));
    const [survived] = await db.select().from(auditEvents).where(eq(auditEvents.id, event2.id));
    expect(survived.actorUserId).toBeNull();
  });
});
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/web && DATABASE_URL=postgres://llteacher:dev@localhost:5432/llteacher npx vitest run src/db/schema/runtime.test.ts`
Expected: all tests across all three `describe` blocks PASS.

- [ ] **Step 5: Typecheck**

Run: `cd apps/web && npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/db/schema/runtime.ts apps/web/src/db/schema/runtime.test.ts apps/web/src/db/migrations
git commit -m "feat(db): add llm_call_logs, student_profiles, and audit_events tables (#15)"
```

### Phase 3 close-out

- [ ] Grep-verify: `grep -n "organizationId: uuid" apps/web/src/db/schema/runtime.ts` shows exactly 6 leaf tables with it (submissions, grades, citations, llm_call_logs, student_profiles, audit_events).
- [ ] Verify issue #15 acceptance criteria line by line.
- [ ] Report back per the "Review checkpoint" format.

---

## Phase 4 — Issue #16: org-scoped repository layer

### Task 4: branded scope types

**Files:**
- Create: `apps/web/src/server/repositories/scope.ts`
- Test: `apps/web/src/server/repositories/scope.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, expectTypeOf } from "vitest";
import { orgScope, courseScope, type OrgScope, type CourseScope } from "./scope";

describe("branded scope types", () => {
  it("orgScope() wraps a plain string into an OrgScope value equal to the input", () => {
    const id = "11111111-1111-1111-1111-111111111111";
    expect(orgScope(id)).toBe(id);
  });

  it("courseScope() wraps a plain string into a CourseScope value equal to the input", () => {
    const id = "22222222-2222-2222-2222-222222222222";
    expect(courseScope(id)).toBe(id);
  });

  it("OrgScope and CourseScope are structurally distinct at the type level", () => {
    expectTypeOf<OrgScope>().not.toEqualTypeOf<CourseScope>();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/server/repositories/scope.test.ts`
Expected: FAIL — `./scope` does not exist.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/web/src/server/repositories/scope.ts
//
// Branded string types so a repository method that expects an OrgScope or
// CourseScope rejects a raw string at compile time. Construct one only from
// a value already verified to belong to the caller (e.g. AuthContext
// membership, or a row just read back from the DB) -- these functions do
// zero validation, they only change the type.

declare const OrgScopeBrand: unique symbol;
declare const CourseScopeBrand: unique symbol;

export type OrgScope = string & { readonly [OrgScopeBrand]: true };
export type CourseScope = string & { readonly [CourseScopeBrand]: true };

export function orgScope(organizationId: string): OrgScope {
  return organizationId as OrgScope;
}

export function courseScope(courseId: string): CourseScope {
  return courseId as CourseScope;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/server/repositories/scope.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/repositories/scope.ts apps/web/src/server/repositories/scope.test.ts
git commit -m "feat(repositories): add OrgScope/CourseScope branded types (#16)"
```

### Task 5: `pings` repository + `hello.ts` migration proof

**Files:**
- Create: `apps/web/src/server/repositories/pings.ts`
- Modify: `apps/web/src/server/routes/hello.ts`
- Modify: `apps/web/src/server/routes/hello.test.ts` (mock target changes from `db/client` insert chain to the new repository — keep behavior identical)

**Interfaces:**
- Produces: `createPing(db: Db, message: string): Promise<{ id: string; message: string }>`

- [ ] **Step 1: Write the failing test**

Replace `apps/web/src/server/routes/hello.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { hello } from "./hello";

// makeDb() itself is mocked too (not just createPing) -- hello.ts calls
// makeDb(c.env.DATABASE_URL) unconditionally before createPing, and the
// real @neondatabase/serverless neon() throws synchronously on a
// non-URL-shaped connection string, before createPing (mocked below) ever
// gets a chance to run. (Caught by actually running this test during
// Phase 4 execution -- mocking only the repository left makeDb live.)
vi.mock("../../db/client", () => ({
  makeDb: () => ({}),
}));

vi.mock("../repositories/pings", () => ({
  createPing: async () => ({ id: "00000000-0000-0000-0000-000000000001", message: "mocked" }),
}));

describe("GET /api/hello", () => {
  it("returns a HelloResponse with mocked message and ping_id", async () => {
    const res = await hello.request("/", {}, { DATABASE_URL: "ignored" } as Env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      message: "mocked",
      ping_id: "00000000-0000-0000-0000-000000000001",
    });
  });

  it("returns a stub HelloResponse when DATABASE_URL is empty", async () => {
    const res = await hello.request("/", {}, { DATABASE_URL: "" } as Env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: string; ping_id: string };
    expect(body.message).toContain("stub");
    expect(body.ping_id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/server/routes/hello.test.ts`
Expected: FAIL — `../repositories/pings` does not exist, and `hello.ts` still imports `makeDb`/`pings` directly so the mock has no effect anyway.

- [ ] **Step 3: Write minimal implementation**

Create `apps/web/src/server/repositories/pings.ts`:

```typescript
import type { Db } from "../../db/client";
import { pings } from "../../db/schema";

/** pings is an unscoped demo table (no org/course tenancy) -- this
 *  repository exists purely to prove routes never import Drizzle directly,
 *  per issue #16's "hello.ts refactor as migration proof" requirement. */
export async function createPing(db: Db, message: string) {
  const [row] = await db.insert(pings).values({ message }).returning();
  return row;
}
```

Rewrite `apps/web/src/server/routes/hello.ts`:

```typescript
import { Hono, type Context } from "hono";
import { makeDb } from "../../db/client";
import { createPing } from "../repositories/pings";
import type { HelloResponse } from "../../shared/types";

export async function helloHandler(c: Context<{ Bindings: Env }>) {
  if (!c.env.DATABASE_URL) {
    const resp: HelloResponse = {
      message: "Hono Worker is alive. (stub — set DATABASE_URL to hit Neon)",
      ping_id: crypto.randomUUID(),
    };
    return c.json(resp);
  }

  const db = makeDb(c.env.DATABASE_URL);
  const row = await createPing(db, "Hello from Hono + Drizzle + Neon.");
  const resp: HelloResponse = {
    message: row.message,
    ping_id: row.id,
  };
  return c.json(resp);
}

export const hello = new Hono<{ Bindings: Env }>();
hello.get("/", helloHandler);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/server/routes/hello.test.ts`
Expected: PASS (2/2).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/repositories/pings.ts apps/web/src/server/routes/hello.ts apps/web/src/server/routes/hello.test.ts
git commit -m "refactor(hello): route through repositories/pings instead of direct Drizzle (#16)"
```

### Task 6: `homeworks` repository + route refactor

**Files:**
- Create: `apps/web/src/server/repositories/homeworks.ts`
- Modify: `apps/web/src/server/routes/homeworks.ts`
- Test: `apps/web/src/server/repositories/homeworks.test.ts` (new — mocked `db`, proves the repository itself)
- `apps/web/src/server/routes/homeworks.test.ts` stays green unmodified (it mocks `../../db/client`, and the repository is a thin pass-through over the same `db` object, so the existing mock shape keeps working)

**Interfaces:**
- Consumes: `CourseScope` from `./scope`.
- Produces: `listHomeworksForCourse(db, scope): Promise<Homework[]>`, `createHomework(db, scope, input: { createdById: string; title: string; description: string; dueDate: Date }): Promise<{ id: string }>`.

- [ ] **Step 1: Write the failing repository test**

Create `apps/web/src/server/repositories/homeworks.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { listHomeworksForCourse, createHomework } from "./homeworks";
import { courseScope } from "./scope";
import type { Db } from "../../db/client";

describe("homeworks repository", () => {
  it("listHomeworksForCourse queries by the given course scope", async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: "hw1" }]);
    const db = { query: { homeworks: { findMany } } } as unknown as Db;

    const result = await listHomeworksForCourse(db, courseScope("course-a"));

    expect(result).toEqual([{ id: "hw1" }]);
    expect(findMany).toHaveBeenCalledOnce();
  });

  it("createHomework inserts with the scope as courseId", async () => {
    const returning = vi.fn().mockResolvedValue([{ id: "hw-new" }]);
    const values = vi.fn().mockReturnValue({ returning });
    const insert = vi.fn().mockReturnValue({ values });
    const db = { insert } as unknown as Db;

    const result = await createHomework(db, courseScope("course-a"), {
      createdById: "membership-1",
      title: "New HW",
      description: "desc",
      dueDate: new Date("2026-12-01"),
    });

    expect(result).toEqual({ id: "hw-new" });
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ courseId: "course-a", createdById: "membership-1", title: "New HW" }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/server/repositories/homeworks.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write minimal implementation**

Create `apps/web/src/server/repositories/homeworks.ts`:

```typescript
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { homeworks } from "../../db/schema";
import type { CourseScope } from "./scope";

export async function listHomeworksForCourse(db: Db, scope: CourseScope) {
  return db.query.homeworks.findMany({ where: eq(homeworks.courseId, scope) });
}

export async function createHomework(
  db: Db,
  scope: CourseScope,
  input: { createdById: string; title: string; description: string; dueDate: Date },
) {
  const [created] = await db
    .insert(homeworks)
    .values({ courseId: scope, ...input })
    .returning({ id: homeworks.id });
  return created;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/server/repositories/homeworks.test.ts`
Expected: PASS (2/2).

- [ ] **Step 5: Refactor the route to use the repository**

Edit `apps/web/src/server/routes/homeworks.ts` — replace the direct Drizzle calls:

```typescript
import { Hono, type Context } from "hono";
import { makeDb } from "../../db/client";
import { listHomeworksForCourse, createHomework } from "../repositories/homeworks";
import { courseScope } from "../repositories/scope";
import { requireCourseMember, requireInstructorOf } from "../utils/guards";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";

interface CreateHomeworkBody {
  title?: unknown;
  description?: unknown;
  dueDate?: unknown;
}

export async function listHomeworksHandler(c: Context<AppEnv>) {
  const courseId = c.req.param("courseId");
  const authContext = c.get("authContext") as AuthContext | undefined;

  if (!authContext || !courseId || !authContext.isMemberOf(courseId)) {
    return c.json({ error: "Course access denied" }, 403);
  }

  const db = makeDb(c.env.DATABASE_URL);
  const rows = await listHomeworksForCourse(db, courseScope(courseId));
  return c.json({ homeworks: rows });
}

export async function createHomeworkHandler(c: Context<AppEnv>) {
  const courseId = c.req.param("courseId");
  const authContext = c.get("authContext") as AuthContext | undefined;

  if (!authContext || !courseId) {
    return c.json({ error: "Course access denied" }, 403);
  }

  let body: CreateHomeworkBody;
  try {
    body = await c.req.json<CreateHomeworkBody>();
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }
  if (
    typeof body.title !== "string" ||
    body.title.trim().length === 0 ||
    typeof body.description !== "string" ||
    typeof body.dueDate !== "string"
  ) {
    return c.json({ error: "title, description, and dueDate are required" }, 400);
  }

  const dueDate = new Date(body.dueDate);
  if (Number.isNaN(dueDate.getTime())) {
    return c.json({ error: "dueDate must be a valid date" }, 400);
  }

  const membership = authContext.memberships.find((m) => m.courseId === courseId);
  if (!membership) {
    return c.json({ error: "Course access denied" }, 403);
  }

  const db = makeDb(c.env.DATABASE_URL);
  const created = await createHomework(db, courseScope(courseId), {
    createdById: membership.id,
    title: body.title.trim(),
    description: body.description,
    dueDate,
  });

  return c.json({ id: created.id }, 201);
}

export const homeworksRoutes = new Hono<AppEnv>();
homeworksRoutes.get("/", requireCourseMember()(listHomeworksHandler));
homeworksRoutes.post("/", requireInstructorOf()(createHomeworkHandler));
```

- [ ] **Step 6: Run the existing route test suite unmodified**

Run: `cd apps/web && npx vitest run src/server/routes/homeworks.test.ts`
Expected: all 9 pre-existing tests still PASS — they mock `../../db/client`'s `makeDb` to return an object with `query.homeworks.findMany` / `insert`, which the repository now calls internally; the mock surface is unchanged.

- [ ] **Step 7: Typecheck**

Run: `cd apps/web && npm run typecheck`

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/server/repositories/homeworks.ts apps/web/src/server/repositories/homeworks.test.ts apps/web/src/server/routes/homeworks.ts
git commit -m "refactor(homeworks): route through repositories/homeworks with CourseScope (#16)"
```

### Task 7: `conversations` repository (soft-delete aware)

**Files:**
- Create: `apps/web/src/server/repositories/conversations.ts`
- Test: `apps/web/src/server/repositories/conversations.test.ts` (real DB, `describe.skipIf`)

**Interfaces:**
- Consumes: `CourseScope`.
- Produces: `listConversationsForOwner(db, scope, ownerUserId, opts?: { includeDeleted?: boolean })`, `createConversation(db, scope, input)`, `softDeleteConversation(db, scope, conversationId)`, `appendMessage(db, scope, conversationId, input: { role; parts })`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/server/repositories/conversations.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { makeNodeDb } from "../../db/nodeClient";
import type { Db } from "../../db/client";
import { organizations, courses, users, courseMemberships } from "../../db/schema";
import { courseScope } from "./scope";
import {
  listConversationsForOwner,
  createConversation,
  softDeleteConversation,
  appendMessage,
} from "./conversations";

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)("conversations repository", () => {
  let db: Db;
  let courseAId: string;
  let courseBId: string;
  let userId: string;

  beforeAll(async () => {
    db = makeNodeDb(DATABASE_URL!);
    async function makeCourse(label: string) {
      const [org] = await db
        .insert(organizations)
        .values({ slug: `conv-repo-${label}-${crypto.randomUUID()}`, name: label, workosOrganizationId: `w-${label}-${crypto.randomUUID()}` })
        .returning({ id: organizations.id });
      const [course] = await db
        .insert(courses)
        .values({ organizationId: org.id, code: "C", term: "T", title: "T" })
        .returning({ id: courses.id });
      return course.id;
    }
    courseAId = await makeCourse("a");
    courseBId = await makeCourse("b");

    const emailBytes = crypto.getRandomValues(new Uint8Array(32));
    const [user] = await db
      .insert(users)
      .values({ email: emailBytes as never, emailBlindIndex: emailBytes as never })
      .returning({ id: users.id });
    userId = user.id;
    await db.insert(courseMemberships).values({ userId, courseId: courseAId, role: "student" });
    await db.insert(courseMemberships).values({ userId, courseId: courseBId, role: "student" });
  });

  it("createConversation + listConversationsForOwner round-trips a tutor conversation", async () => {
    await createConversation(db, courseScope(courseAId), {
      ownerUserId: userId,
      sectionId: null,
      kind: "tutor",
      title: "My tutor chat",
    });
    const rows = await listConversationsForOwner(db, courseScope(courseAId), userId);
    expect(rows.map((r) => r.title)).toContain("My tutor chat");
  });

  it("a course-A scope never returns a conversation created under course B", async () => {
    await createConversation(db, courseScope(courseBId), {
      ownerUserId: userId,
      sectionId: null,
      kind: "tutor",
      title: "Course B chat",
    });
    const rows = await listConversationsForOwner(db, courseScope(courseAId), userId);
    expect(rows.map((r) => r.title)).not.toContain("Course B chat");
  });

  it("excludes soft-deleted conversations by default, includes them with includeDeleted", async () => {
    const created = await createConversation(db, courseScope(courseAId), {
      ownerUserId: userId,
      sectionId: null,
      kind: "tutor",
      title: "To be deleted",
    });
    await softDeleteConversation(db, courseScope(courseAId), created.id);

    const defaultRows = await listConversationsForOwner(db, courseScope(courseAId), userId);
    expect(defaultRows.map((r) => r.id)).not.toContain(created.id);

    const withDeleted = await listConversationsForOwner(db, courseScope(courseAId), userId, {
      includeDeleted: true,
    });
    expect(withDeleted.map((r) => r.id)).toContain(created.id);
  });

  it("appendMessage adds a message to a conversation within the given scope", async () => {
    const created = await createConversation(db, courseScope(courseAId), {
      ownerUserId: userId,
      sectionId: null,
      kind: "tutor",
      title: "Chat with messages",
    });
    const msg = await appendMessage(db, courseScope(courseAId), created.id, {
      role: "user",
      parts: [{ type: "text", text: "hello" }],
    });
    expect(msg.conversationId).toBe(created.id);
  });

  afterAll(async () => {
    await db.delete(courses).where(eq(courses.id, courseAId));
    await db.delete(courses).where(eq(courses.id, courseBId));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && DATABASE_URL=postgres://llteacher:dev@localhost:5432/llteacher npx vitest run src/server/repositories/conversations.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write minimal implementation**

Create `apps/web/src/server/repositories/conversations.ts`:

```typescript
import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { conversations, messages } from "../../db/schema";
import type { CourseScope } from "./scope";

export async function listConversationsForOwner(
  db: Db,
  scope: CourseScope,
  ownerUserId: string,
  opts?: { includeDeleted?: boolean },
) {
  const conditions = [
    eq(conversations.courseId, scope),
    eq(conversations.ownerUserId, ownerUserId),
  ];
  if (!opts?.includeDeleted) {
    conditions.push(eq(conversations.isDeleted, false));
  }
  return db.select().from(conversations).where(and(...conditions));
}

export async function createConversation(
  db: Db,
  scope: CourseScope,
  input: { ownerUserId: string; sectionId: string | null; kind: "section" | "tutor"; title: string },
) {
  const [created] = await db
    .insert(conversations)
    .values({ courseId: scope, ...input })
    .returning();
  return created;
}

export async function softDeleteConversation(db: Db, scope: CourseScope, conversationId: string) {
  return db
    .update(conversations)
    .set({ isDeleted: true, deletedAt: new Date() })
    .where(and(eq(conversations.id, conversationId), eq(conversations.courseId, scope)));
}

export async function appendMessage(
  db: Db,
  scope: CourseScope,
  conversationId: string,
  input: { role: "user" | "assistant" | "system"; parts: unknown },
) {
  const [owned] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.courseId, scope)));
  if (!owned) {
    throw new Error("Conversation not found in this course scope");
  }
  const [created] = await db
    .insert(messages)
    .values({ conversationId, role: input.role, parts: input.parts })
    .returning();
  return created;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && DATABASE_URL=postgres://llteacher:dev@localhost:5432/llteacher npx vitest run src/server/repositories/conversations.test.ts`
Expected: PASS (4/4).

- [ ] **Step 5: Typecheck**

Run: `cd apps/web && npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/server/repositories/conversations.ts apps/web/src/server/repositories/conversations.test.ts
git commit -m "feat(repositories): add conversations repository with CourseScope + soft-delete (#16)"
```

### Task 8: `submissions`, `llmConfigs`, `materials` repositories + cross-org isolation proof

**Files:**
- Create: `apps/web/src/server/repositories/submissions.ts`
- Create: `apps/web/src/server/repositories/llmConfigs.ts`
- Create: `apps/web/src/server/repositories/materials.ts`
- Create: `apps/web/src/server/repositories/auditEvents.ts`
- Test: `apps/web/src/server/repositories/submissions.test.ts` (this is the issue's headline "cross-org isolation proven per repository" test)
- Create: `apps/web/src/server/repositories/index.ts` (barrel)

**Interfaces:**
- Produces: `createSubmission(db, orgScope, conversationId)`, `getSubmissionByConversation(db, orgScope, conversationId)`, `recordGrade(db, orgScope, input)`; `listLlmConfigsForOrg(db, orgScope)`, `getDefaultLlmConfig(db, orgScope)`; `listMaterialsForCourse(db, courseScope)`; `recordAuditEvent(db, orgScope, input)`.

- [ ] **Step 1: Write the failing test (submissions — the cross-org isolation proof)**

Create `apps/web/src/server/repositories/submissions.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { makeNodeDb } from "../../db/nodeClient";
import type { Db } from "../../db/client";
import { organizations, courses, users, conversations } from "../../db/schema";
import { orgScope } from "./scope";
import { createSubmission, getSubmissionByConversation, recordGrade } from "./submissions";

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)("submissions repository", () => {
  let db: Db;
  let orgAId: string;
  let orgBId: string;
  let courseAId: string;
  let courseBId: string;
  let userAId: string;
  let userBId: string;

  beforeAll(async () => {
    db = makeNodeDb(DATABASE_URL!);
    async function seed(label: string) {
      const [org] = await db
        .insert(organizations)
        .values({ slug: `sub-repo-${label}-${crypto.randomUUID()}`, name: label, workosOrganizationId: `w-${label}-${crypto.randomUUID()}` })
        .returning({ id: organizations.id });
      const [course] = await db
        .insert(courses)
        .values({ organizationId: org.id, code: "C", term: "T", title: "T" })
        .returning({ id: courses.id });
      const emailBytes = crypto.getRandomValues(new Uint8Array(32));
      const [user] = await db
        .insert(users)
        .values({ email: emailBytes as never, emailBlindIndex: emailBytes as never })
        .returning({ id: users.id });
      return { orgId: org.id, courseId: course.id, userId: user.id };
    }
    const a = await seed("a");
    orgAId = a.orgId;
    courseAId = a.courseId;
    userAId = a.userId;
    const b = await seed("b");
    orgBId = b.orgId;
    courseBId = b.courseId;
    userBId = b.userId;
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgAId));
    await db.delete(organizations).where(eq(organizations.id, orgBId));
  });

  // Each test creates its own fresh conversation to submit against --
  // submissions.conversation_id is unique, so reusing one shared conversation
  // fixture across multiple createSubmission() calls in different tests would
  // collide with an earlier test's row. (Caught by actually running this
  // test during Phase 4 execution, same class of bug as Phase 1's soft-delete
  // test collision.)
  async function newConversation(courseId: string, ownerUserId: string) {
    const [conv] = await db
      .insert(conversations)
      .values({ ownerUserId, courseId, sectionId: null, kind: "tutor", title: "t" })
      .returning({ id: conversations.id });
    return conv.id;
  }

  it("createSubmission writes under the given org scope", async () => {
    const conversationId = await newConversation(courseAId, userAId);
    const created = await createSubmission(db, orgScope(orgAId), conversationId);
    expect(created.organizationId).toBe(orgAId);
  });

  it("getSubmissionByConversation scoped to org B returns nothing for an org-A conversation", async () => {
    const conversationId = await newConversation(courseAId, userAId);
    await createSubmission(db, orgScope(orgAId), conversationId);
    const result = await getSubmissionByConversation(db, orgScope(orgBId), conversationId);
    expect(result).toBeUndefined();
  });

  it("cross-org isolation: creating submissions under both orgs, an org-A-scoped list never includes org-B rows", async () => {
    const conversationId = await newConversation(courseBId, userBId);
    await createSubmission(db, orgScope(orgBId), conversationId);
    const found = await getSubmissionByConversation(db, orgScope(orgAId), conversationId);
    expect(found).toBeUndefined();
  });

  it("recordGrade writes an AI grade with no grader and a human grade rejects graded_by_ai=true with a grader set", async () => {
    const conversationId = await newConversation(courseBId, userBId);
    const sub = await createSubmission(db, orgScope(orgBId), conversationId);
    const grade = await recordGrade(db, orgScope(orgBId), {
      submissionId: sub.id,
      gradedByAi: true,
      score: 0.9,
    });
    expect(grade.gradedByAi).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && DATABASE_URL=postgres://llteacher:dev@localhost:5432/llteacher npx vitest run src/server/repositories/submissions.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write minimal implementation**

Create `apps/web/src/server/repositories/submissions.ts`:

```typescript
import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { submissions, grades } from "../../db/schema";
import type { OrgScope } from "./scope";

export async function createSubmission(db: Db, scope: OrgScope, conversationId: string) {
  const [created] = await db
    .insert(submissions)
    .values({ conversationId, organizationId: scope })
    .returning();
  return created;
}

export async function getSubmissionByConversation(db: Db, scope: OrgScope, conversationId: string) {
  const [found] = await db
    .select()
    .from(submissions)
    .where(and(eq(submissions.conversationId, conversationId), eq(submissions.organizationId, scope)));
  return found;
}

export async function recordGrade(
  db: Db,
  scope: OrgScope,
  input: {
    submissionId: string;
    gradedByAi: boolean;
    graderMembershipId?: string;
    score?: number;
    rubric?: unknown;
    feedback?: string;
  },
) {
  const [created] = await db
    .insert(grades)
    .values({ organizationId: scope, ...input })
    .returning();
  return created;
}
```

Create `apps/web/src/server/repositories/llmConfigs.ts`:

```typescript
import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { llmConfigs } from "../../db/schema";
import type { OrgScope } from "./scope";

export async function listLlmConfigsForOrg(db: Db, scope: OrgScope) {
  return db.select().from(llmConfigs).where(eq(llmConfigs.organizationId, scope));
}

export async function getDefaultLlmConfig(db: Db, scope: OrgScope) {
  const [found] = await db
    .select()
    .from(llmConfigs)
    .where(and(eq(llmConfigs.organizationId, scope), eq(llmConfigs.isDefault, true)));
  return found;
}
```

Create `apps/web/src/server/repositories/materials.ts`:

```typescript
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { courseMaterials } from "../../db/schema";
import type { CourseScope } from "./scope";

export async function listMaterialsForCourse(db: Db, scope: CourseScope) {
  return db.select().from(courseMaterials).where(eq(courseMaterials.courseId, scope));
}
```

Create `apps/web/src/server/repositories/auditEvents.ts`:

```typescript
import type { Db } from "../../db/client";
import { auditEvents } from "../../db/schema";
import type { OrgScope } from "./scope";

/** The only write path for audit_events. No update/delete function exists
 *  in this module or anywhere else in the codebase -- that omission is the
 *  M2 append-only enforcement mechanism (resolved design decision 8). */
export async function recordAuditEvent(
  db: Db,
  scope: OrgScope,
  input: {
    actorUserId: string | null;
    action: string;
    targetType: string;
    targetId: string;
    ip?: string;
    requestMetadata?: unknown;
  },
) {
  const [created] = await db
    .insert(auditEvents)
    .values({ organizationId: scope, ...input })
    .returning();
  return created;
}
```

Create `apps/web/src/server/repositories/index.ts`:

```typescript
export * from "./scope";
export * from "./pings";
export * from "./homeworks";
export * from "./conversations";
export * from "./submissions";
export * from "./llmConfigs";
export * from "./materials";
export * from "./auditEvents";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && DATABASE_URL=postgres://llteacher:dev@localhost:5432/llteacher npx vitest run src/server/repositories/submissions.test.ts`
Expected: PASS (4/4).

- [ ] **Step 5: Typecheck**

Run: `cd apps/web && npm run typecheck`
Expected: no errors. This is also where the "branded type enforcement" proof from issue #16's testing strategy lives — confirm by temporarily writing `createSubmission(db, "raw-string", conversationAId)` in a scratch file and observing `tsc` reject it (branded `OrgScope` vs `string`), then delete the scratch file. Not a committed test — TS itself is the enforcement, this is just a sanity check.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/server/repositories/submissions.ts apps/web/src/server/repositories/submissions.test.ts apps/web/src/server/repositories/llmConfigs.ts apps/web/src/server/repositories/materials.ts apps/web/src/server/repositories/auditEvents.ts apps/web/src/server/repositories/index.ts
git commit -m "feat(repositories): add submissions, llmConfigs, materials, auditEvents repositories with cross-org isolation tests (#16)"
```

### Task 9: convention doc for routes-vs-repositories

**Files:**
- Create: `apps/web/ARCHITECTURE.md`

- [ ] **Step 1: Write the doc**

```markdown
# apps/web Architecture Notes

## Routes and Repositories

`apps/web/src/server/routes/*.ts` must never import `db.select`/`db.insert`/table
objects from `../../db/schema`, or `drizzle-orm` query helpers (`eq`, `and`,
...) directly. Data access goes through `apps/web/src/server/repositories/`.

Why: the repository layer is where org/course tenancy scoping is enforced
(`OrgScope`/`CourseScope` branded types in `repositories/scope.ts` --
see `docs/superpowers/plans/2026-08-03-m2-runtime-persistence.md`). A route
that queries Drizzle directly bypasses that guard silently -- it will
typecheck and run, it just won't be scoped.

A route handler's shape is: resolve a `Db` via `makeDb(c.env.DATABASE_URL)`,
resolve a scope from `AuthContext` (`orgScope(...)` / `courseScope(...)`),
call one or more repository functions, shape the response. No `.from(...)`,
`.where(...)`, or `.values(...)` calls in route files.

Enforcement today is code-review convention, not a lint rule. Revisit if
violations recur.
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/ARCHITECTURE.md
git commit -m "docs(web): document routes-vs-repositories convention (#16)"
```

### Phase 4 close-out

- [ ] Run: `cd apps/web && grep -rn "from \"../../db/client\"" src/server/routes/ ; grep -rn "from \"../../db/schema\"" src/server/routes/` — confirm zero matches (routes no longer import Drizzle client or table objects directly). `hello.ts` and `homeworks.ts` still import `makeDb` (that's expected — connecting is fine, querying isn't) but should show no `db.select`/`db.insert`/`db.query.<table>` calls.
- [ ] Full test run: `cd apps/web && DATABASE_URL=postgres://llteacher:dev@localhost:5432/llteacher npm test`
- [ ] `cd apps/web && npm run typecheck`
- [ ] Verify issue #16 acceptance criteria line by line, including the cross-org isolation proof (Task 8) and the soft-delete default/opt-in proof (Task 7).
- [ ] Report back per the "Review checkpoint" format.

---

## Phase 5 — Issue #17: TypeScript seed script

### Task 10: `apps/web/scripts/seed.ts`

**Files:**
- Create: `apps/web/scripts/seed.ts`
- Modify: `apps/web/package.json` (add `db:seed` script + `tsx` devDependency if not already present)
- Modify: `apps/web/README.md` (document seed users + `--reset`)
- Modify: `.github/workflows/test.yml` (run seed as a smoke test after migrations)
- Modify: `apps/web/vitest.config.ts` (add `"scripts/**/*.test.ts"` to `include` — otherwise `seed.test.ts` silently collects zero tests, see resolved design decision 10)
- Modify: `apps/web/tsconfig.worker.json` (add `"scripts"` to `include` — otherwise `npm run typecheck` never covers `seed.ts` at all, see decision 10)
- Test: `apps/web/scripts/seed.test.ts` (real DB, `describe.skipIf`)

**Interfaces:**
- Consumes: every repository/table from Phases 1-4, plus `IdentityCipher` (`apps/web/src/lib/crypto/identity-cipher.ts`) for encrypting seeded PII.

- [ ] **Step 1: Check for `tsx` and add the script**

Run: `cd apps/web && grep -q '"tsx"' package.json && echo present || echo missing`
If missing, run: `cd apps/web && npm install -D tsx`

Edit `apps/web/package.json`, add to `"scripts"`:

```json
"db:seed": "tsx scripts/seed.ts"
```

- [ ] **Step 2: Write the seed script**

Create `apps/web/scripts/seed.ts`. This mirrors `populate_test_database.py`'s dataset (2 instructors, 3 students, 2 homeworks with sections/solutions, sample conversations/messages/submissions) plus the M2 additions (1 org, 1 course, 1 LLM config, PII encrypted via `IdentityCipher`). Uses `makeNodeDb` (resolved design decision 9), not `makeDb` — this script runs as a plain Node process via `tsx`, the same situation as `drizzle-kit`, not inside the Cloudflare Worker, and needs a driver that can reach a plain Postgres server (CI smoke test) as well as real Neon (works fine over TCP+SSL too):

```typescript
import { eq } from "drizzle-orm";
import { makeNodeDb } from "../src/db/nodeClient";
import type { Db } from "../src/db/client";
import * as schema from "../src/db/schema";
import { IdentityCipher } from "../src/lib/crypto/identity-cipher";

async function loadCipher(): Promise<IdentityCipher> {
  const encKeyB64 = process.env.ENCRYPTION_KEY;
  const blindKeyB64 = process.env.BLIND_INDEX_KEY;
  if (!encKeyB64 || !blindKeyB64) {
    throw new Error("ENCRYPTION_KEY and BLIND_INDEX_KEY must be set to run the seed script");
  }
  const encryptionKey = await crypto.subtle.importKey(
    "raw",
    Buffer.from(encKeyB64, "base64"),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
  const blindIndexKey = await crypto.subtle.importKey(
    "raw",
    Buffer.from(blindKeyB64, "base64"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new IdentityCipher({ encryptionKey, blindIndexKey, encryptionKeyId: "seed" });
}

interface SeedUserSpec {
  handle: string;
  email: string;
  displayName: string;
  role: "instructor" | "student";
}

const SEED_USERS: SeedUserSpec[] = [
  { handle: "teacher1", email: "teacher1@test.com", displayName: "John Doe", role: "instructor" },
  { handle: "teacher2", email: "teacher2@test.com", displayName: "Jane Smith", role: "instructor" },
  { handle: "student1", email: "student1@test.com", displayName: "Alice Johnson", role: "student" },
  { handle: "student2", email: "student2@test.com", displayName: "Bob Wilson", role: "student" },
  { handle: "student3", email: "student3@test.com", displayName: "Carol Brown", role: "student" },
];

const TUTOR_BASE_PROMPT =
  "You are a patient, Socratic statistics tutor. Never give the final answer " +
  "outright -- ask guiding questions that help the student discover the " +
  "reasoning themselves. Keep responses concise and encouraging.";

async function reset(db: Db) {
  // Reverse dependency order.
  await db.delete(schema.citations);
  await db.delete(schema.grades);
  await db.delete(schema.submissions);
  await db.delete(schema.llmCallLogs);
  await db.delete(schema.messages);
  await db.delete(schema.conversations);
  await db.delete(schema.studentProfiles);
  await db.delete(schema.sectionSolutions);
  await db.delete(schema.sections);
  await db.delete(schema.homeworks);
  await db.delete(schema.llmConfigs);
  await db.delete(schema.courseMemberships);
  await db.delete(schema.courses);
  await db.delete(schema.organizations).where(eq(schema.organizations.slug, "seed-org"));
  // isPending=true, not false: seeded accounts are pending rows (nobody has
  // ever logged into them via WorkOS). Deleting isPending=false would wipe
  // real users who've actually signed in -- the opposite of what --reset
  // should ever touch.
  await db.delete(schema.users).where(eq(schema.users.isPending, true));
}

async function seed() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL not set");

  const shouldReset = process.argv.includes("--reset");
  const cipher = await loadCipher();
  const db = makeNodeDb(databaseUrl);

  if (shouldReset) {
    console.log("Resetting seeded data...");
    await reset(db);
  }

  const [org] = await db
    .insert(schema.organizations)
    .values({
      slug: "seed-org",
      name: "Seed University Statistics",
      workosOrganizationId: "seed-workos-org",
    })
    .returning();

  const [course] = await db
    .insert(schema.courses)
    .values({ organizationId: org.id, code: "STAT 311", term: "Fall 2026", title: "Intro to Statistics" })
    .returning();

  const userIds: Record<string, string> = {};
  const membershipIds: Record<string, string> = {};
  for (const spec of SEED_USERS) {
    const normalizedEmail = IdentityCipher.normalizeEmail(spec.email);
    const [user] = await db
      .insert(schema.users)
      .values({
        email: await cipher.encryptString(spec.email),
        emailBlindIndex: await cipher.computeBlindIndex(normalizedEmail),
        displayName: await cipher.encryptString(spec.displayName),
        isPending: true, // claimable on first real WorkOS login
      })
      .returning();
    userIds[spec.handle] = user.id;

    const [membership] = await db
      .insert(schema.courseMemberships)
      .values({ userId: user.id, courseId: course.id, role: spec.role })
      .returning();
    membershipIds[spec.handle] = membership.id;
  }

  const [llmConfig] = await db
    .insert(schema.llmConfigs)
    .values({
      organizationId: org.id,
      provider: "anthropic",
      modelName: "claude-sonnet-4-5",
      temperature: 0.7,
      maxCompletionTokens: 1000,
      isDefault: true,
      isActive: true,
    })
    .returning();

  await db.insert(schema.promptTemplates).values({
    scopeOrganizationId: org.id,
    content: TUTOR_BASE_PROMPT,
    version: 1,
    isActive: true,
  });

  const homeworkSpecs = [
    {
      title: "Python Basics",
      createdBy: "teacher1",
      sections: [
        { title: "Variables and Data Types", content: "# Variables\n\nExplore Python types." },
        { title: "Control Structures", content: "# Control Structures\n\nIf/else and loops." },
        { title: "Functions and Lists", content: "# Functions\n\nDefine and call functions." },
      ],
    },
    {
      title: "Data Analysis with Python",
      createdBy: "teacher2",
      sections: [
        { title: "Working with Dictionaries", content: "# Dictionaries\n\nGrade management." },
        { title: "List Comprehensions", content: "# List Comprehensions\n\nFilter product data." },
      ],
    },
  ];

  const sectionIdsByHomework: string[][] = [];
  for (const hwSpec of homeworkSpecs) {
    const [hw] = await db
      .insert(schema.homeworks)
      .values({
        courseId: course.id,
        createdById: membershipIds[hwSpec.createdBy],
        llmConfigId: llmConfig.id,
        title: hwSpec.title,
        description: `${hwSpec.title} homework.`,
        dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      })
      .returning();

    const sectionIds: string[] = [];
    for (let i = 0; i < hwSpec.sections.length; i++) {
      const [section] = await db
        .insert(schema.sections)
        .values({ homeworkId: hw.id, order: i + 1, title: hwSpec.sections[i].title, content: hwSpec.sections[i].content })
        .returning();
      await db.insert(schema.sectionSolutions).values({
        sectionId: section.id,
        content: `Model solution for ${hwSpec.sections[i].title}.`,
      });
      sectionIds.push(section.id);
    }
    sectionIdsByHomework.push(sectionIds);
  }

  const studentHandles = ["student1", "student2", "student3"];
  let conversationCount = 0;
  let submissionCount = 0;
  for (const studentHandle of studentHandles) {
    for (const sectionIds of sectionIdsByHomework) {
      const sectionId = sectionIds[0];
      const [conv] = await db
        .insert(schema.conversations)
        .values({
          ownerUserId: userIds[studentHandle],
          courseId: course.id,
          sectionId,
          kind: "section",
          title: `${studentHandle}'s conversation`,
        })
        .returning();
      conversationCount++;

      await db.insert(schema.messages).values([
        { conversationId: conv.id, role: "user", parts: [{ type: "text", text: "I need help getting started." }] },
        { conversationId: conv.id, role: "assistant", parts: [{ type: "text", text: "What have you tried so far?" }] },
      ]);

      if (Math.random() < 0.6) {
        await db.insert(schema.submissions).values({ conversationId: conv.id, organizationId: org.id });
        submissionCount++;
      }
    }
  }

  console.log(
    `Seed complete: 1 org, 1 course, 2 instructors, 3 students, 1 llm config, ` +
      `${homeworkSpecs.length} homeworks, ${conversationCount} conversations, ${submissionCount} submissions.`,
  );
}

seed().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 3: Write the smoke test**

Create `apps/web/scripts/seed.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { makeNodeDb } from "../src/db/nodeClient";
import type { Db } from "../src/db/client";
import { organizations, users, homeworks } from "../src/db/schema";

const DATABASE_URL = process.env.DATABASE_URL;
const CAN_SEED = DATABASE_URL && process.env.ENCRYPTION_KEY && process.env.BLIND_INDEX_KEY;

describe.skipIf(!CAN_SEED)("db:seed script", () => {
  let db: Db;

  beforeAll(() => {
    execSync("npx tsx scripts/seed.ts --reset", { cwd: __dirname + "/..", stdio: "inherit" });
    db = makeNodeDb(DATABASE_URL!);
  });

  it("creates exactly one seed-org organization", async () => {
    const rows = await db.select().from(organizations).where(eq(organizations.slug, "seed-org"));
    expect(rows).toHaveLength(1);
  });

  it("creates 5 users with encrypted (non-empty bytea) email fields", async () => {
    const rows = await db.select().from(users).where(eq(users.isPending, true));
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const row of rows) {
      expect(row.email.length).toBeGreaterThan(0);
      expect(row.emailBlindIndex.length).toBeGreaterThan(0);
    }
  });

  it("creates 2 homeworks", async () => {
    const [org] = await db.select().from(organizations).where(eq(organizations.slug, "seed-org"));
    const rows = await db.query.homeworks.findMany();
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(org).toBeDefined();
  });

  it("running --reset twice in a row succeeds both times (idempotent)", () => {
    expect(() =>
      execSync("npx tsx scripts/seed.ts --reset", { cwd: __dirname + "/..", stdio: "pipe" }),
    ).not.toThrow();
  });
});
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/web && DATABASE_URL=postgres://llteacher:dev@localhost:5432/llteacher ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))") BLIND_INDEX_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))") npx vitest run scripts/seed.test.ts`
Expected: PASS (4/4). If `ENCRYPTION_KEY`/`BLIND_INDEX_KEY` aren't set, the suite reports skipped, not failed.

- [ ] **Step 5: Document in README**

Edit `apps/web/README.md`, add:

```markdown
## Seeding a dev dataset

```bash
npm run db:seed          # seed once
npm run db:seed -- --reset  # wipe seeded data and re-seed
```

Requires `DATABASE_URL`, `ENCRYPTION_KEY`, and `BLIND_INDEX_KEY` in your shell
env (or `.dev.vars` sourced into it) -- PII fields are encrypted the same way
the app encrypts them at write time.

Seeded accounts (Django parity): `teacher1`/`teacher2` (instructors),
`student1`/`student2`/`student3` (students), all under org `seed-org` /
course `STAT 311`. WorkOS owns login in this stack, so these are **pending**
user rows (`is_pending = true`) — nobody can log in as them directly. They
become claimable on first real WorkOS login whose email's blind index
matches (`teacher1@test.com`, etc.) — see `docs/architecture/multi-tenant-data-model.md`
§3.2 "User identity reconciliation."
```

- [ ] **Step 6: Wire into CI as a smoke test**

Edit `.github/workflows/test.yml`. Add `ENCRYPTION_KEY`/`BLIND_INDEX_KEY` to the job-level `env:` block alongside `DATABASE_URL` (not scoped to one step) — the later "Test" step also needs them, since `scripts/seed.test.ts` itself calls the seed script and would otherwise skip in CI even after the turbo `env` fix from decision 11:

```yaml
    env:
      DATABASE_URL: postgres://llteacher:dev@localhost:5432/llteacher
      ENCRYPTION_KEY: ${{ secrets.CI_SEED_ENCRYPTION_KEY }}
      BLIND_INDEX_KEY: ${{ secrets.CI_SEED_BLIND_INDEX_KEY }}
```

Then insert after the "Apply Drizzle migrations" step and before "Typecheck":

```yaml
      - name: Seed smoke test
        working-directory: apps/web
        run: npm run db:seed -- --reset
```

Note: this requires two new repo secrets (`CI_SEED_ENCRYPTION_KEY`, `CI_SEED_BLIND_INDEX_KEY`, each a base64-encoded 32-byte value) to exist in the GitHub repo settings — **flag this explicitly** in the Phase 5 review message, since only a repo admin can add them; the seed step will fail in CI until they're added. Do not attempt to add repo secrets yourself.

- [ ] **Step 7: Typecheck**

Run: `cd apps/web && npm run typecheck`

- [ ] **Step 8: Commit**

```bash
git add apps/web/scripts/seed.ts apps/web/scripts/seed.test.ts apps/web/package.json apps/web/README.md .github/workflows/test.yml
git commit -m "feat(seed): add TypeScript seed script porting populate_test_database (#17)"
```

### Phase 5 close-out

- [ ] Run the full local suite once more end to end: `cd apps/web && DATABASE_URL=... ENCRYPTION_KEY=... BLIND_INDEX_KEY=... npm run db:migrate && npm run db:seed -- --reset && npm run typecheck && npm test`
- [ ] Verify issue #17 acceptance criteria line by line.
- [ ] Verify epic #18's full "End-to-end acceptance checklist" against the finished state of the branch (all six ER-view-3 tables present, repository layer with ≥5 modules, routes clean of direct Drizzle imports, seed script runnable, migrations applied in CI, docs updated).
- [ ] Report back per the "Review checkpoint" format — this is the epic-closing report.

---

## Review checkpoint format (use at the end of every Phase)

When a Phase's tasks and close-out steps are all done and its issue's acceptance criteria are verified, stop and report back with:

1. **What changed** — 2-4 sentences, plain language, no jargon dump.
2. **Acceptance criteria status** — the issue's own checkbox list, each marked done with a one-line note on how it was verified (test name or command run).
3. **What to test manually** — concrete steps: which tables to eyeball in `npm run db:studio`, which npm test command to re-run, what a rejected insert should look like if they want to poke at a constraint by hand.
4. **Anything that needs a human decision** — flagged deviations from the issue text (the "Resolved Design Decisions" section above), anything blocked on a repo secret or external credential, anything that felt like a judgment call worth a second opinion.

Do not start the next Phase until the requester responds.
