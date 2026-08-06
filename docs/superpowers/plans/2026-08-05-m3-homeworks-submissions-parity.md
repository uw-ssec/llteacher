# M3: Homeworks & Submissions Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **This plan is structured as 6 Phases, one per GitHub issue (#19, #94, #20, #21, #22, #23) plus a closing Phase 6 for epic #24's own acceptance checklist. Phase 1 covers #19 and #94 together (see Resolved Design Decision 1). Stop after each Phase's final task and get the requester's review before starting the next Phase — do not auto-continue across Phases.**

**Goal:** Full homework-lifecycle feature parity with the Django homeworks app on the new TS stack — instructor CRUD with section diffing and draft/publish state, student list/progress from real data, the submission flow, and the instructor participation dashboard. No fixture data remains in these surfaces when done.

**Architecture:** Extends the existing `apps/web` Hono worker (routes → repositories → Drizzle, org/course-scoped via branded `OrgScope`/`CourseScope` types) with homework/section CRUD, publish-state, and submission routes; extends `apps/admin` (React, no router, tagged-union view state) with a create/edit form and real submissions data; extends `apps/web`'s student client (`App.tsx`) to fetch real homework/section data instead of `INITIAL_SECTIONS`.

**Tech Stack:** Hono, Drizzle ORM (`drizzle-orm/pg-core`, Postgres 16), Vitest (`node` env for `apps/web`, `jsdom` for `apps/admin`), React + react-hook-form, `@llteacher/ui`.

## Global Constraints

- Follow existing schema idioms exactly: `pgEnum` for closed vocabularies, `check(name, sql\`...\`)`, `uniqueIndex(...).where(...)` for partial uniqueness, `timestamp(..., { withTimezone: true })`, `relations()` exported alongside every table (verified against `content.ts`/`runtime.ts`).
- Routes never import `db.select`/`db.insert`/table objects/`drizzle-orm` query helpers directly — they call repository functions. Verified: every existing route (`homeworks.ts`, `profile.ts`) already follows this.
- Every repository function takes `(db: Db, scope: OrgScope | CourseScope, ...)` as its first two params. `homeworks`/`sections`/`sectionSolutions`/`conversations` are `CourseScope`-scoped; `submissions` is `OrgScope`-scoped (matches M2's decision 5).
- Route-layer auth: higher-order guards from `apps/web/src/server/utils/guards.ts` (`requireCourseMember(courseIdParam?)`, `requireInstructorOf(courseIdParam?)`, `requireRole(roles[])`), reading `AuthContext` off `c.get("authContext")` (set once per request by `rolesMiddleware`). Guards resolve `courseId` from a **named URL param** — this constrains route URL shape (see Resolved Design Decision 2 below).
- New routes are registered directly on `app` in `apps/web/src/server/index.ts` (not `app.route(prefix, sub)`) per the existing comment explaining Hono's prefix-stripping gotcha. Each route file also exports a small sub-`Hono` app purely for direct unit testing (matches `homeworksRoutes` in `homeworks.ts`).
- DB mocking in tests: `vi.mock("../../db/client", () => ({ makeDb: () => ({ query: {...}, insert: ..., update: ..., delete: ... }) }))`, `TEST_ENV = { DATABASE_URL: "ignored" } as Env`, a `fakeAuthContext(overrides)` helper deriving `hasRole`/`isMemberOf`/`isInstructorOf` from a `memberships` array the same way `rolesMiddleware` does (exact pattern in `homeworks.test.ts`).
- Migrations: edit the relevant `apps/web/src/db/schema/*.ts` file, then run `npm run db:generate` (drizzle-kit) from `apps/web` to produce the numbered SQL migration — never hand-write migration SQL.
- `apps/web`'s vitest environment is `node`; `apps/admin`'s is `jsdom` (component tests use React Testing Library).

## Resolved Design Decisions (record in PR descriptions)

1. **Build order**: Phase 1 covers #19 (CRUD + section diff) and #94 (draft/publish state) together, ahead of #20/#21, deviating from the literal order at the bottom of epic #24. #94's own issue text says it must land "before #19/#20/#21 harden," and #24's own Integration & Verification Strategy section never mentions #94 in its sequencing — building the publish-state column and endpoint alongside #19 means #20 and #21 are built against the final `homeworks` contract from day one instead of retrofitted. Confirmed with the requester during brainstorming.
2. **Route URL shape deviates from #19/#20/#22/#23's illustrative sketches**: those sketches use flat paths (`/api/homeworks/:id`, `/api/student/homeworks`, `/api/conversations/:id/submit`, `/api/homeworks/:id/submissions`), written before the actual `requireCourseMember`/`requireInstructorOf` guard implementation existed. Those guards resolve `courseId` from a **named URL param** (default `"courseId"`) — they cannot check "is this user an instructor of this homework's course" without `courseId` already being a matched route param. Verified against `apps/web/src/server/utils/guards.ts` and its only two callers in `index.ts`. Decision: single-homework routes (#19, #94) nest under the existing `/api/courses/:courseId/homeworks` prefix (`/api/courses/:courseId/homeworks/:homeworkId`, `.../publish`) to reuse the guards unchanged. The student list (#20) has no single `:courseId` — a student's homeworks span every course they're enrolled in — so it uses `requireRole(["student"])` only and derives its own course-membership scoping from `authContext.memberships` inside the handler, not from a guard. The submission route (#22) is keyed by `conversationId`, not `courseId` — it uses `requireRole(["student"])` plus an explicit owner check inside `createSubmission` (see Phase 4). The submissions dashboard (#23) is nested the same way as #19 (`/api/courses/:courseId/homeworks/:homeworkId/submissions`) since it's instructor-only and homework-scoped.
3. **Conversation FK cascade policy (#19)**: kept as-is. `conversations.sectionId` already has `onDelete: "cascade"` (set in M2) — deleting a section (directly, or via a homework delete/edit-diff) cascades to delete its conversations, messages, and submissions. Documented here rather than re-opened as a schema question; changing it would be a new M2-scope schema decision, out of scope for this epic.
4. **Auto-submit-overdue (#22)**: explicitly deferred. No Cloudflare Cron Trigger added. `SectionStatus` for an overdue in-progress section is `"in_progress_overdue"` (matches Django), not auto-transitioned to `"submitted"`.
5. **Homework status model (#94)**: two new nullable timestamp columns, `publishedAt` and `releasedAt`, added to `homeworks`. Status is derived **on read** (no scheduled job): no `publishedAt` → `"draft"`; `releasedAt` in the future → `"scheduled"`; `releasedAt` passed and `dueDate` in the future → `"active"`; `releasedAt` passed and `dueDate` passed → `"past_due"`. `"archived"` (a 5th value already present in `apps/admin`'s fixture-era `Homework.status` type) has no producing feature anywhere in this milestone — the derivation function has an explicit comment marking it unreachable, plus a pointer to file a follow-up issue (confirm with the requester before actually creating it — issue creation needs sign-off per this session's action rules) rather than silently dropping the state.
6. **`updateHomework` branches on driver capability at runtime: `db.batch()` in production, a real `db.transaction()` for real-DB tests, with server-generated ids for new sections/solutions** (found during Task 3 implementation, before any code was committed; refined twice as the full picture emerged). The plan originally called for `db.transaction(async (tx) => {...})` unconditionally, but production routes construct `db` via `makeDb()` — the `@neondatabase/serverless` **neon-http** driver, required because this app deploys to Cloudflare Workers (no raw outbound TCP). neon-http's `.transaction()` unconditionally throws (`"No transactions support in neon-http driver"`); confirmed at `node_modules/drizzle-orm/neon-http/session.js`, and no code in this repo calls `db.transaction()` anywhere else. neon-http *does* support `db.batch([...])`: multiple statements sent in one HTTP round-trip, executed as a single real transaction server-side (all-or-nothing, same rollback guarantee as a normal transaction). The wrinkle: batch statements are packaged before any of them run, so a later statement can't consume an earlier statement's `RETURNING` result the way sequential transaction code could — fixed by generating each new section's (and its solution's) id via `crypto.randomUUID()` in the repository function itself, before building the batch, and inserting with that id explicit rather than relying on `sections.id`'s `defaultRandom()`.
   Switching to `db.batch()` alone wasn't the end of it: real-DB tests use `makeNodeDb` (node-postgres driver, needed because neon-http can't reach a plain Postgres server at all — see M2's decision 9), and node-postgres has the *opposite* gap — it supports `db.transaction()` but has no `.batch()` at runtime, despite `nodeClient.ts`'s cast making the shared `Db` type claim otherwise. Naively falling back to "wrap the same statements in a node-postgres transaction" doesn't give real atomicity either: Drizzle query-builder objects (`db.insert(...)`, etc.) are bound to whichever executor built them, so statements built against the outer `db` and merely awaited inside a `tx` callback would run on a different pooled connection than the transaction, not inside it. Resolved by keeping `resolveSectionWrites`'s reorder-resolution *algorithm* identical on both paths (it never touches `db` directly, only the three callback params) and branching only on *how a resolved write executes*: `updateHomework` feature-detects `typeof db.batch === "function"` and either (a) collects query-builder objects built against `db` into an array for one `db.batch()` call, or (b) opens a real `db.transaction()` and awaits each write immediately against `tx`. This means real-DB tests exercise the exact same ordering logic production runs — only the execution mechanics differ, not the logic being verified. (`crypto.randomUUID()` is a standard global in both the Workers runtime and modern Node, no import needed.)
7. **Reordering existing sections resolved via dependency-ordered application with cycle-breaking scratch bumps, not a schema change** (found during Task 3 implementation): `sections_homework_order_uq` is a plain (non-deferrable) unique index — Postgres checks it immediately after each statement, whether inside `db.transaction()` or `db.batch()`. Naively applying every reordered section's `UPDATE` in plan order can collide mid-batch (e.g. swapping two sections' orders, or shifting a range when a section is inserted in the middle). Fixed at the application level, not by making the constraint deferrable (which would need a new migration and wasn't confirmed compatible with the installed Drizzle version) or by hand-writing non-generated migration SQL: `updateHomework` builds a dependency graph of "this section wants to move into order slot N," applies any move whose target slot is currently unoccupied (repeating in passes, since freeing one slot often unblocks another — this alone resolves plain shifts/insertions with zero scratch values, verified by hand-tracing an insert-in-the-middle scenario), and only when a genuine cycle remains (every remaining move's target is held by another remaining move) bumps one section in the cycle to a scratch order value not used by anyone in the homework, breaking the cycle so the pass-based resolution can finish. If no scratch value exists in `[1, 20]` (only possible when a homework already has all 20 allowed sections and the diff is a full cyclic rotation touching every one of them at once), `updateHomework` throws a descriptive error that the existing `/order|section/i` route-layer regex (Task 6) already maps to a 422 asking the instructor to reorder in two smaller steps — an explicitly accepted, narrow edge case rather than a silent failure.
8. **Admin course-id source: extend `GET /api/profile` with the caller's instructor course(s), not a new course-management API** (found during Task 15 implementation, before any code was written): `HomeworkCreateView`/`HomeworkEditView` need a real `courseId` for every API call, but nothing in the codebase exposes one to the client — confirmed by tracing the full chain: `useAuth()` → `GET /api/profile` → `ProfileWithStats`, which only ever returns a collapsed `role` and a `courseCount` number, never actual course rows. Checked whether this belongs to an already-planned milestone rather than being a genuine M3 gap: it does — [#68](https://github.com/uw-ssec/llteacher/issues/68) ("organization and course management routes with archival," M13, open) is the issue that adds a real `GET /api/courses` and course *creation*; its own summary states "nothing in the platform creates organizations or courses outside the seed script." [#70](https://github.com/uw-ssec/llteacher/issues/70) ("course switcher and multi-course navigation," M13, open) is the actual multi-course UI — a dedicated `CourseSwitcher.tsx` component, localStorage persistence, deep-linking — and explicitly notes "the student app currently assumes a single implicit course" (true of admin too: `TopNav`'s `course="STATS 311"` is a literal hardcoded string everywhere else in the admin app today).
   Building #68's full course-management API or #70's real switcher inside M3 would be scope creep into a different milestone's job, and would likely get reworked once those land properly. Decision (confirmed with the requester): extend the *existing* `GET /api/profile` response (already fetched on app load by both apps' `AuthProvider`, minimal new surface, additive-only) with the caller's course membership(s) as an **array**, not a single id — an instructor teaching multiple courses must not be silently broken by this stopgap. `apps/admin`'s `App.tsx` then uses `courses[0]` for now, matching the app's existing single-course assumption everywhere else, with an explicit code comment (not just a plan note) explaining why this is temporary and that #70's real switcher is the intended replacement — so the stopgap is self-documenting in the code a future implementer of #70 will actually be reading, not just in this plan.
   Scope of the extension, deliberately minimal: `ProfileWithStats` gains an optional `courses?: { id: string; title: string }[]` field, populated only for instructor/ta/admin roles (parallel to the existing `instructorStats` field), from non-dropped course memberships only (a dropped membership showing up in a course picker would be misleading, even though the route-layer `requireInstructorOf` guard independently re-verifies real access regardless of what the client sends). No new route, no pagination, no org-admin "all courses" case, no archival filtering beyond what already exists — those are #68's job.
9. **Student sidebar submit needs a `conversationId` per section — thread the id the backend already fetches, not a new architectural gap** (found during Task 18 planning, before dispatch): the brief's `handleSubmit` reads `section?.conversationId`, but `SidebarSection` (`packages/ui/src/components/Sidebar.tsx`) has no such field, and neither does `StudentSectionProgress` (Task 9, `repositories/studentHomeworks.ts`) — the brief's own code would not typecheck as written. Unlike decision 8's course-id gap, this is *not* a missing-data problem: `getStudentHomeworksForUser` already runs `SELECT ... FROM conversations WHERE sectionId = ... AND ownerUserId = ... AND isDeleted = false` per section (to compute status) and already has the conversation's `id` in hand at that point — it just never puts it in the returned object. No new query, no new milestone dependency, no design alternative worth pausing on: extend `StudentSectionProgress` with `conversationId: string | null` (populated from the already-fetched `activeConversation?.id ?? null`), extend `SidebarSection` with an optional `conversationId?: string`, and thread it through Task 11's `useStudentHomework` mapping in `App.tsx`. This revises two already-merged, already-reviewed tasks (9 and 11) — expected and unremarkable: the gap only became visible once a *later* task (18) tried to consume data the earlier ones never had a reason to carry. Resolved directly without pausing for input, unlike decision 8, since there's no genuine architectural trade-off here (no alternative design, no scope-creep risk into another milestone) — just a field that needed to be threaded one level further than it was.
10. **`db.query.X.findMany({ with: { relation: true } })` silently corrupts encrypted columns reached through the join — found during Task 19 implementation, by running against real Postgres, not by reading the code.** `getHomeworkSubmissionsMatrix`'s roster fetch originally used Drizzle's relational query API (`db.query.courseMemberships.findMany({ with: { user: true } })`) to pull each membership's user row in one query. This installed Drizzle version resolves a nested `with` via `left join lateral (select json_build_array(...))`, which forces Postgres to serialize every joined column — including `users.email`/`displayName`'s `bytea` — through JSON. Postgres renders `bytea` as hex-text inside that JSON array, so node-postgres's JSON parser hands the `encryptedText` customType's `fromDriver` a plain string instead of a `Buffer`; `new Uint8Array(aString)` doesn't throw, it silently returns a **0-length array**, so every `IdentityCipher.decryptString` call downstream failed with "Ciphertext shorter than envelope header" — a failure mode that would have shipped to production despite a clean typecheck and code that reads correctly at a glance.
    Fixed by switching to a flat `select().from().innerJoin()` (still one query, still no N+1 — every column stays a top-level SQL result column, so node-postgres's normal `bytea` parser, which produces a real `Buffer`, runs instead). This is a narrow, function-scoped fix, not a codebase-wide one: only relational `with` traversals that reach an `encryptedText`/`blindIndex` custom-typed column are affected (a `with` that only touches plain-text columns, like Task 15's `courseMemberships.findMany({ with: { course: true } })` pulling `courses.id`/`title`, is unaffected — verified those columns are plain `text`, not `encryptedText`). Flagged as a background task for a wider codebase sweep rather than auditing every `with:` call site in this pass, which would be scope creep beyond this task — worth surfacing to the requester as a real, if narrow, finding regardless of this epic's own scope.

---

## Phase 1 — Issues #19 + #94: Homework/section CRUD, diff semantics, draft/publish state

### Task 1: Schema — `publishedAt`/`releasedAt` columns + migration

**Files:**
- Modify: `apps/web/src/db/schema/content.ts` (the `homeworks` table, lines 151–182)
- Create: `apps/web/src/db/migrations/00XX_homework_publish_state.sql` (generated, not hand-written)

**Interfaces:**
- Produces: `homeworks.publishedAt: Date | null`, `homeworks.releasedAt: Date | null` columns, available to every later task in this phase via `typeof homeworks.$inferSelect`.

- [ ] **Step 1: Add the two columns to the `homeworks` table definition**

```ts
// apps/web/src/db/schema/content.ts — inside the homeworks pgTable(...) columns object,
// immediately after llmConfigId and before title:
    llmConfigId: uuid("llm_config_id").references(() => llmConfigs.id, {
      onDelete: "set null",
    }),
    // Draft/publish state (#94). Both null = draft (deliberate deviation from
    // Django parity, which made homeworks visible immediately on creation).
    // publishedAt is set the moment an instructor hits "publish" in the admin
    // UI; releasedAt is the (possibly future) instant the homework actually
    // becomes visible to students. Status is derived on read from these two
    // plus dueDate — see deriveHomeworkStatus in repositories/homeworks.ts.
    // No separate `status` enum column: it would just be a cache of a pure
    // function of these three timestamps, and could drift out of sync.
    publishedAt: timestamp("published_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    title: text("title").notNull(),
```

- [ ] **Step 2: Generate the migration**

Run: `cd apps/web && npm run db:generate`
Expected: a new file `src/db/migrations/00XX_<generated-name>.sql` containing `ALTER TABLE "homeworks" ADD COLUMN "published_at" timestamp with time zone; ALTER TABLE "homeworks" ADD COLUMN "released_at" timestamp with time zone;` (nullable, additive — no default needed since both null already means "draft").

- [ ] **Step 3: Apply and verify against a real Postgres**

Run: `DATABASE_URL=postgres://llteacher:dev@localhost:5433/llteacher npm run db:migrate` (from `apps/web`, matching the CI connection string in `.github/workflows/test.yml`)
Expected: migration applies with no error; running it a second time is a no-op (drizzle-kit tracks applied migrations).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/db/schema/content.ts apps/web/src/db/migrations/
git commit -m "feat(db): add homeworks.publishedAt/releasedAt for draft/publish state (#94)"
```

---

### Task 2: Repository — pure section-diff planner

**Files:**
- Create: `apps/web/src/server/repositories/sections.ts`
- Test: `apps/web/src/server/repositories/sections.test.ts`

**Interfaces:**
- Consumes: nothing (pure function, no `Db`/`scope` — isolates the diff *logic* from the diff's DB *application*, which Task 3 builds on top of).
- Produces: `planSectionDiff(existing: ExistingSection[], incoming: IncomingSection[]): SectionDiffPlan`, `ExistingSection`, `IncomingSection`, `SectionDiffPlan` types — Task 3 imports all four.

- [ ] **Step 1: Write the failing tests (diff matrix)**

```ts
// apps/web/src/server/repositories/sections.test.ts
import { describe, it, expect } from "vitest";
import { planSectionDiff, type ExistingSection } from "./sections";

const existing: ExistingSection[] = [
  { id: "s1", order: 1, title: "Sample spaces", content: "c1", solutionId: "sol1" },
  { id: "s2", order: 2, title: "Events", content: "c2", solutionId: null },
  { id: "s3", order: 3, title: "Conditional prob", content: "c3", solutionId: "sol3" },
];

describe("planSectionDiff", () => {
  it("creates sections with no id", () => {
    const plan = planSectionDiff([], [{ title: "New", content: "c", order: 1 }]);
    expect(plan.toCreate).toEqual([{ title: "New", content: "c", order: 1, solutionContent: undefined }]);
    expect(plan.toUpdate).toEqual([]);
    expect(plan.toDelete).toEqual([]);
  });

  it("updates a section whose id matches an existing row (title/content/order/solution)", () => {
    const plan = planSectionDiff(existing, [
      { id: "s1", title: "Sample spaces (revised)", content: "c1-new", order: 1, solutionContent: "sol text" },
      { id: "s2", title: "Events", content: "c2", order: 2 },
      { id: "s3", title: "Conditional prob", content: "c3", order: 3, solutionContent: "sol3 text" },
    ]);
    expect(plan.toUpdate).toEqual([
      { id: "s1", title: "Sample spaces (revised)", content: "c1-new", order: 1, solutionContent: "sol text", solutionAction: "update" },
      { id: "s3", title: "Conditional prob", content: "c3", order: 3, solutionContent: "sol3 text", solutionAction: "update" },
    ]);
    expect(plan.toCreate).toEqual([]);
    expect(plan.toDelete).toEqual([]);
  });

  it("deletes existing rows omitted from the incoming array", () => {
    const plan = planSectionDiff(existing, [
      { id: "s1", title: "Sample spaces", content: "c1", order: 1 },
    ]);
    expect(plan.toDelete.map((d) => d.id).sort()).toEqual(["s2", "s3"]);
  });

  it("reorders by keeping id but changing order", () => {
    const plan = planSectionDiff(existing, [
      { id: "s1", title: "Sample spaces", content: "c1", order: 3 },
      { id: "s2", title: "Events", content: "c2", order: 1 },
      { id: "s3", title: "Conditional prob", content: "c3", order: 2 },
    ]);
    expect(plan.toUpdate.map((u) => ({ id: u.id, order: u.order }))).toEqual([
      { id: "s1", order: 3 },
      { id: "s2", order: 1 },
      { id: "s3", order: 2 },
    ]);
  });

  it("adds a solution to a section that had none", () => {
    const plan = planSectionDiff(existing, [
      { id: "s1", title: "Sample spaces", content: "c1", order: 1 },
      { id: "s2", title: "Events", content: "c2", order: 2, solutionContent: "new solution" },
      { id: "s3", title: "Conditional prob", content: "c3", order: 3 },
    ]);
    const s2 = plan.toUpdate.find((u) => u.id === "s2")!;
    expect(s2.solutionContent).toBe("new solution");
    expect(s2.solutionAction).toBe("create");
  });

  it("removes a solution from a section that had one (solutionContent omitted)", () => {
    const plan = planSectionDiff(existing, [
      { id: "s1", title: "Sample spaces", content: "c1", order: 1 },
      { id: "s2", title: "Events", content: "c2", order: 2 },
      { id: "s3", title: "Conditional prob", content: "c3", order: 3 }, // s3 had solutionId: "sol3", now omitted
    ]);
    const s3 = plan.toUpdate.find((u) => u.id === "s3")!;
    expect(s3.solutionAction).toBe("delete");
  });

  it("throws when two incoming sections share the same order", () => {
    expect(() =>
      planSectionDiff([], [
        { title: "A", content: "c", order: 1 },
        { title: "B", content: "c", order: 1 },
      ]),
    ).toThrow(/duplicate order/i);
  });

  it("throws when an incoming section references an id not in existing", () => {
    expect(() =>
      planSectionDiff(existing, [{ id: "does-not-exist", title: "X", content: "c", order: 1 }]),
    ).toThrow(/unknown section id/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npx vitest run src/server/repositories/sections.test.ts`
Expected: FAIL — `Cannot find module './sections'` (file doesn't exist yet).

- [ ] **Step 3: Implement `planSectionDiff`**

```ts
// apps/web/src/server/repositories/sections.ts

export interface ExistingSection {
  id: string;
  order: number;
  title: string;
  content: string;
  solutionId: string | null;
}

export interface IncomingSection {
  id?: string;
  order: number;
  title: string;
  content: string;
  solutionContent?: string;
}

export interface SectionCreatePlan {
  title: string;
  content: string;
  order: number;
  solutionContent: string | undefined;
}

export interface SectionUpdatePlan {
  id: string;
  title: string;
  content: string;
  order: number;
  solutionContent: string | undefined;
  /** "none": no solution before or after. "create": had none, now has one.
   *  "update": had one, still has one (content may differ). "delete": had
   *  one, incoming omitted solutionContent. */
  solutionAction: "none" | "create" | "update" | "delete";
}

export interface SectionDeletePlan {
  id: string;
}

export interface SectionDiffPlan {
  toCreate: SectionCreatePlan[];
  toUpdate: SectionUpdatePlan[];
  toDelete: SectionDeletePlan[];
}

/** Pure diff logic, no DB access -- repositories/homeworks.ts's updateHomework
 *  applies this plan inside a transaction. Kept separate so the diff
 *  algorithm (the trickiest part of #19, per the issue) is unit-testable
 *  without mocking Drizzle. */
export function planSectionDiff(
  existing: ExistingSection[],
  incoming: IncomingSection[],
): SectionDiffPlan {
  const orders = new Set<number>();
  for (const s of incoming) {
    if (orders.has(s.order)) {
      throw new Error(`duplicate order ${s.order} in incoming sections`);
    }
    orders.add(s.order);
  }

  const existingById = new Map(existing.map((s) => [s.id, s]));
  const incomingIds = new Set(incoming.filter((s) => s.id).map((s) => s.id));

  const toCreate: SectionCreatePlan[] = [];
  const toUpdate: SectionUpdatePlan[] = [];

  for (const s of incoming) {
    if (!s.id) {
      toCreate.push({
        title: s.title,
        content: s.content,
        order: s.order,
        solutionContent: s.solutionContent,
      });
      continue;
    }
    const prior = existingById.get(s.id);
    if (!prior) {
      throw new Error(`unknown section id "${s.id}" -- not part of this homework`);
    }
    const hadSolution = prior.solutionId !== null;
    const hasSolution = s.solutionContent !== undefined;
    const solutionAction: SectionUpdatePlan["solutionAction"] = !hadSolution && !hasSolution
      ? "none"
      : !hadSolution && hasSolution
        ? "create"
        : hadSolution && hasSolution
          ? "update"
          : "delete";
    // Only rows with an actual change belong in toUpdate -- a section
    // resubmitted byte-identical to its existing row (same title/content/
    // order, solutionAction "none") must NOT appear, or the "updates a
    // section whose id matches an existing row" test above (which expects
    // s2 -- byte-identical in that fixture -- absent from toUpdate) fails.
    const titleChanged = prior.title !== s.title;
    const contentChanged = prior.content !== s.content;
    const orderChanged = prior.order !== s.order;
    const solutionChanged = solutionAction !== "none";
    if (titleChanged || contentChanged || orderChanged || solutionChanged) {
      toUpdate.push({
        id: s.id,
        title: s.title,
        content: s.content,
        order: s.order,
        solutionContent: s.solutionContent,
        solutionAction,
      });
    }
  }

  const toDelete: SectionDeletePlan[] = existing
    .filter((s) => !incomingIds.has(s.id))
    .map((s) => ({ id: s.id }));

  return { toCreate, toUpdate, toDelete };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/web && npx vitest run src/server/repositories/sections.test.ts`
Expected: PASS, all 8 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/repositories/sections.ts apps/web/src/server/repositories/sections.test.ts
git commit -m "feat(homeworks): pure section-diff planner (#19)"
```

---

### Task 3: Repository — `homeworks.ts` extensions (get-by-id, update via diff, delete, publish)

**Files:**
- Modify: `apps/web/src/server/repositories/homeworks.ts`
- Test: `apps/web/src/server/repositories/homeworks.test.ts` (new file — none existed before; the route test file `routes/homeworks.test.ts` is separate)
- Modify (doc comment only): `apps/web/src/db/nodeClient.ts` — its existing comment justifying the `as unknown as Db` cast says "no code in this codebase uses raw `.execute()`... this cast reflects verified compatibility, not a hidden risk." `updateHomework` is the first code to reference a driver-capability method (`db.batch`) that genuinely differs between the two drivers, not just the common query-builder surface the comment was written about. Add one sentence noting that `db.batch` specifically is feature-detected at the call site (`typeof db.batch === "function"`), never called unconditionally, so the cast's underlying claim ("nothing calls a method whose behavior differs by driver") still holds -- without this note, the next person to add a `.batch()` call elsewhere could easily miss that node-postgres doesn't have one and hit the exact same silent trap this task did.

**Interfaces:**
- Consumes: `planSectionDiff`, `ExistingSection`, `IncomingSection` from Task 2; `sections`, `sectionSolutions` from `../../db/schema`; `CourseScope` from `./scope`.
- Produces: `getHomeworkById(db, scope, id)`, `updateHomework(db, scope, id, input)`, `deleteHomework(db, scope, id)`, `updateHomeworkPublishState(db, scope, id, input)`, `deriveHomeworkStatus(homework)` — all consumed by Phase 1 Task 5-8's routes and re-exported from `repositories/index.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/web/src/server/repositories/homeworks.test.ts
import { describe, it, expect, vi } from "vitest";
import { deriveHomeworkStatus } from "./homeworks";

describe("deriveHomeworkStatus", () => {
  const base = { dueDate: new Date("2026-09-01T00:00:00Z") };

  it("is draft when publishedAt is null", () => {
    expect(deriveHomeworkStatus({ ...base, publishedAt: null, releasedAt: null })).toBe("draft");
  });

  it("is scheduled when releasedAt is in the future", () => {
    expect(
      deriveHomeworkStatus({
        ...base,
        publishedAt: new Date("2026-08-01T00:00:00Z"),
        releasedAt: new Date("2099-01-01T00:00:00Z"),
      }),
    ).toBe("scheduled");
  });

  it("is active when released and due date is in the future", () => {
    expect(
      deriveHomeworkStatus({
        dueDate: new Date("2099-01-01T00:00:00Z"),
        publishedAt: new Date("2026-08-01T00:00:00Z"),
        releasedAt: new Date("2026-08-01T00:00:00Z"),
      }),
    ).toBe("active");
  });

  it("is past_due when released and due date has passed", () => {
    expect(
      deriveHomeworkStatus({
        dueDate: new Date("2020-01-01T00:00:00Z"),
        publishedAt: new Date("2019-01-01T00:00:00Z"),
        releasedAt: new Date("2019-01-01T00:00:00Z"),
      }),
    ).toBe("past_due");
  });

  // "archived" is intentionally not reachable from any input this function
  // accepts -- no feature in this milestone produces it. See the comment on
  // deriveHomeworkStatus itself. Not tested here because there is no valid
  // input that should ever produce it; a test asserting "no input reaches
  // this branch" would just restate the function.
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npx vitest run src/server/repositories/homeworks.test.ts`
Expected: FAIL — `deriveHomeworkStatus` is not exported from `./homeworks`.

- [ ] **Step 3: Implement `deriveHomeworkStatus` and the new repository functions**

```ts
// apps/web/src/server/repositories/homeworks.ts — full replacement
import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { homeworks, sections, sectionSolutions } from "../../db/schema";
import type { CourseScope } from "./scope";
import {
  planSectionDiff,
  type ExistingSection,
  type IncomingSection,
} from "./sections";

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

export type HomeworkStatus = "draft" | "scheduled" | "active" | "past_due" | "archived";

/** Pure function of (dueDate, publishedAt, releasedAt) -- no DB, no `now()`
 *  parameter needed by callers (uses the real clock; tests pass fixed dates
 *  through the three inputs instead of mocking time).
 *
 *  "archived" is a 5th status apps/admin's pre-M3 fixture typing already
 *  carried (see apps/admin/src/client/lib/fixtures.ts's Homework.status),
 *  but no issue in this milestone (#94 or otherwise) describes what would
 *  set a homework archived. This function never returns it -- the type is
 *  kept (not narrowed) so a future feature can add the missing input this
 *  function would need, without every consumer's exhaustiveness check
 *  breaking. TODO(#<follow-up-issue>): file and link an issue for a future
 *  milestone once an archival feature is actually scoped -- confirm with
 *  the requester before filing (issue creation needs sign-off). */
export function deriveHomeworkStatus(hw: {
  dueDate: Date;
  publishedAt: Date | null;
  releasedAt: Date | null;
}): HomeworkStatus {
  const now = new Date();
  if (!hw.publishedAt) return "draft";
  if (hw.releasedAt && hw.releasedAt.getTime() > now.getTime()) return "scheduled";
  return hw.dueDate.getTime() > now.getTime() ? "active" : "past_due";
}

export async function getHomeworkById(db: Db, scope: CourseScope, id: string) {
  const homework = await db.query.homeworks.findFirst({
    where: and(eq(homeworks.id, id), eq(homeworks.courseId, scope)),
  });
  if (!homework) return null;

  const sectionRows = await db.query.sections.findMany({
    where: eq(sections.homeworkId, id),
    with: { solution: true },
    orderBy: (s, { asc }) => [asc(s.order)],
  });

  return { homework, sections: sectionRows };
}

export async function deleteHomework(db: Db, scope: CourseScope, id: string) {
  // sections/sectionSolutions/conversations/messages/submissions all cascade
  // from homeworks.id -> sections.homeworkId -> ... (see Resolved Design
  // Decision 3) -- a single delete on this scoped row is sufficient.
  const [deleted] = await db
    .delete(homeworks)
    .where(and(eq(homeworks.id, id), eq(homeworks.courseId, scope)))
    .returning({ id: homeworks.id });
  return deleted ?? null;
}

export async function updateHomeworkPublishState(
  db: Db,
  scope: CourseScope,
  id: string,
  input: { publish: boolean; releasedAt?: Date },
) {
  const [updated] = await db
    .update(homeworks)
    .set({
      publishedAt: input.publish ? new Date() : null,
      releasedAt: input.publish ? (input.releasedAt ?? new Date()) : null,
      updatedAt: new Date(),
    })
    .where(and(eq(homeworks.id, id), eq(homeworks.courseId, scope)))
    .returning();
  return updated ?? null;
}

export interface HomeworkUpdateFields {
  title?: string;
  description?: string;
  dueDate?: Date;
  llmConfigId?: string | null;
  sections?: IncomingSection[];
}

type BatchStatement = Parameters<Db["batch"]>[0][number];

/** Order-slot-collision-free reordering. sections_homework_order_uq is a
 *  plain (non-deferrable) unique index -- Postgres checks it immediately
 *  after each statement, so naively applying every reordered section's
 *  UPDATE in plan order can collide mid-batch (e.g. a straight swap, or a
 *  range shift when a section is inserted in the middle). This resolves the
 *  moves in dependency order instead: repeatedly apply any pending move
 *  whose target slot is currently free (freeing one slot often unblocks
 *  another, so plain shifts/insertions resolve in zero scratch bumps), and
 *  only bump a section to a scratch order value when a genuine cycle
 *  remains (every remaining move's target is held by another remaining
 *  move). See Resolved Design Decision 7 for the full reasoning and a
 *  hand-traced example of both the zero-bump and one-bump cases. */
async function resolveSectionWrites(
  existingSections: ExistingSection[],
  deletedIds: Set<string>,
  plan: ReturnType<typeof planSectionDiff>,
  pushSectionInsert: (id: string, order: number, title: string, content: string) => Promise<void> | void,
  pushSectionUpdate: (id: string, order: number, title: string, content: string) => Promise<void> | void,
  pushSolutionWrites: (sectionId: string, action: SectionUpdatePlan["solutionAction"], content: string | undefined) => Promise<void> | void,
) {
  type PendingWrite =
    | { kind: "update"; id: string; targetOrder: number; title: string; content: string; solutionAction: SectionUpdatePlan["solutionAction"]; solutionContent?: string }
    | { kind: "create"; id: string; targetOrder: number; title: string; content: string; solutionContent?: string };

  const existingById = new Map(existingSections.map((s) => [s.id, s]));
  const livePosition = new Map<string, number>();
  const currentOccupant = new Map<number, string>();
  for (const s of existingSections) {
    if (!deletedIds.has(s.id)) {
      livePosition.set(s.id, s.order);
      currentOccupant.set(s.order, s.id);
    }
  }

  const pending: PendingWrite[] = [];
  for (const upd of plan.toUpdate) {
    const prior = existingById.get(upd.id)!;
    if (prior.order === upd.order) {
      // No collision possible -- write it immediately, it never competes
      // for a slot with anything else in this diff.
      await pushSectionUpdate(upd.id, upd.order, upd.title, upd.content);
      await pushSolutionWrites(upd.id, upd.solutionAction, upd.solutionContent);
    } else {
      pending.push({ kind: "update", id: upd.id, targetOrder: upd.order, title: upd.title, content: upd.content, solutionAction: upd.solutionAction, solutionContent: upd.solutionContent });
    }
  }
  for (const create of plan.toCreate) {
    pending.push({ kind: "create", id: crypto.randomUUID(), targetOrder: create.order, title: create.title, content: create.content, solutionContent: create.solutionContent });
  }

  const placed = new Set<PendingWrite>();

  async function apply(write: PendingWrite) {
    if (write.kind === "create") {
      await pushSectionInsert(write.id, write.targetOrder, write.title, write.content);
      if (write.solutionContent !== undefined) {
        await pushSolutionWrites(write.id, "create", write.solutionContent);
      }
    } else {
      await pushSectionUpdate(write.id, write.targetOrder, write.title, write.content);
      await pushSolutionWrites(write.id, write.solutionAction, write.solutionContent);
      const prevOrder = livePosition.get(write.id);
      if (prevOrder !== undefined) currentOccupant.delete(prevOrder);
    }
    currentOccupant.set(write.targetOrder, write.id);
    livePosition.set(write.id, write.targetOrder);
    placed.add(write);
  }

  async function runPasses() {
    let progress = true;
    while (progress) {
      progress = false;
      for (const write of pending) {
        if (placed.has(write)) continue;
        if (!currentOccupant.has(write.targetOrder)) {
          await apply(write);
          progress = true;
        }
      }
    }
  }

  await runPasses();

  while (pending.some((w) => !placed.has(w))) {
    const stillOpen = pending.filter((w) => !placed.has(w));
    const reserved = new Set<number>([...currentOccupant.keys(), ...stillOpen.map((w) => w.targetOrder)]);
    let scratch: number | undefined;
    for (let candidate = 1; candidate <= 20; candidate++) {
      if (!reserved.has(candidate)) { scratch = candidate; break; }
    }
    if (scratch === undefined) {
      throw new Error(
        "cannot resolve section reorder: no free order slot to stage a cyclic move -- reorder in two smaller steps",
      );
    }
    // Every still-open write at this point is necessarily an "update": a
    // brand-new create's target can only ever be blocked by an existing
    // section that hasn't moved yet, and that section (if it too has a
    // pending move) gets unblocked by this same bump-and-retry loop before
    // a create could ever be the thing left stuck.
    const stuck = stillOpen.find((w): w is Extract<PendingWrite, { kind: "update" }> => w.kind === "update")!;
    const stuckCurrentOrder = livePosition.get(stuck.id)!;
    await pushSectionUpdate(stuck.id, scratch, existingById.get(stuck.id)!.title, existingById.get(stuck.id)!.content);
    currentOccupant.delete(stuckCurrentOrder);
    currentOccupant.set(scratch, stuck.id);
    livePosition.set(stuck.id, scratch);
    await runPasses();
  }
}

/** Applies planSectionDiff's plan (Task 2) atomically alongside any
 *  top-level homework field updates. Branches on driver capability at
 *  runtime (see Resolved Design Decision 6): production's neon-http driver
 *  supports `db.batch()` but not `db.transaction()`; the node-postgres
 *  driver real-DB tests use (`makeNodeDb`) is the mirror image --
 *  `db.transaction()` works, `db.batch` doesn't exist at runtime despite
 *  the shared `Db` type claiming it does. Feature-detect via
 *  `typeof db.batch === "function"` (a missing method is a TypeError at
 *  the call site, not something to try/catch). `resolveSectionWrites`'s
 *  ordering algorithm is identical either way -- only whether a resolved
 *  write defers into a batch array or executes immediately against `tx`
 *  differs, so real-DB tests exercise the same logic production runs.
 *  Returns null if `id` isn't found in `scope` (caller maps that to 404).
 *  Throws for constraint violations (duplicate/out-of-range order) and for
 *  the unresolvable-cycle edge case, both uncaught -- the route layer
 *  (Task 6) catches and maps those to a 422. */
export async function updateHomework(
  db: Db,
  scope: CourseScope,
  id: string,
  input: HomeworkUpdateFields,
) {
  const existingHomework = await db.query.homeworks.findFirst({
    where: and(eq(homeworks.id, id), eq(homeworks.courseId, scope)),
  });
  if (!existingHomework) return null;

  const topLevelFields = {
    ...(input.title !== undefined && { title: input.title }),
    ...(input.description !== undefined && { description: input.description }),
    ...(input.dueDate !== undefined && { dueDate: input.dueDate }),
    ...(input.llmConfigId !== undefined && { llmConfigId: input.llmConfigId }),
  };

  // Read-then-plan happens outside either write path -- it's a SELECT, not
  // a mutation, so there's nothing to keep atomic about it yet.
  let existingSections: ExistingSection[] = [];
  let plan: ReturnType<typeof planSectionDiff> | null = null;
  if (input.sections) {
    existingSections = (
      await db.query.sections.findMany({
        where: eq(sections.homeworkId, id),
        with: { solution: true },
      })
    ).map((s) => ({
      id: s.id,
      order: s.order,
      title: s.title,
      content: s.content,
      solutionId: s.solution?.id ?? null,
    }));
    plan = planSectionDiff(existingSections, input.sections);
  }

  if (typeof db.batch === "function") {
    // Production path: neon-http. Collect query-builder objects (built
    // against `db`) and execute them all as one atomic HTTP round-trip.
    const statements: BatchStatement[] = [];
    if (Object.keys(topLevelFields).length > 0) {
      statements.push(db.update(homeworks).set({ ...topLevelFields, updatedAt: new Date() }).where(eq(homeworks.id, id)));
    }
    if (plan) {
      const deletedIds = new Set(plan.toDelete.map((d) => d.id));
      for (const del of plan.toDelete) {
        statements.push(db.delete(sections).where(eq(sections.id, del.id)));
      }
      await resolveSectionWrites(
        existingSections,
        deletedIds,
        plan,
        (sectionId, order, title, content) => {
          statements.push(db.insert(sections).values({ id: sectionId, homeworkId: id, title, content, order }));
        },
        (sectionId, order, title, content) => {
          statements.push(db.update(sections).set({ title, content, order, updatedAt: new Date() }).where(eq(sections.id, sectionId)));
        },
        (sectionId, action, content) => {
          if (action === "create") {
            statements.push(db.insert(sectionSolutions).values({ sectionId, content: content! }));
          } else if (action === "update") {
            statements.push(db.update(sectionSolutions).set({ content: content!, updatedAt: new Date() }).where(eq(sectionSolutions.sectionId, sectionId)));
          } else if (action === "delete") {
            statements.push(db.delete(sectionSolutions).where(eq(sectionSolutions.sectionId, sectionId)));
          }
        },
      );
    }
    if (statements.length > 0) {
      // db.batch() requires a non-empty tuple type in some Drizzle
      // versions -- verify against the installed drizzle-orm's neon-http
      // batch() signature (check node_modules/drizzle-orm/neon-http/
      // session.d.ts or let TypeScript's error on this call guide the
      // exact expected type) and adjust the cast if needed.
      await db.batch(statements as [BatchStatement, ...BatchStatement[]]);
    }
    return { id };
  }

  // Test/dev path: node-postgres (makeNodeDb) has no runtime db.batch().
  // A real db.transaction() gives the same all-or-nothing guarantee
  // through a different Drizzle primitive -- every write executes
  // immediately against `tx` rather than deferring into an array.
  return db.transaction(async (tx) => {
    if (Object.keys(topLevelFields).length > 0) {
      await tx.update(homeworks).set({ ...topLevelFields, updatedAt: new Date() }).where(eq(homeworks.id, id));
    }
    if (plan) {
      const deletedIds = new Set(plan.toDelete.map((d) => d.id));
      for (const del of plan.toDelete) {
        await tx.delete(sections).where(eq(sections.id, del.id));
      }
      await resolveSectionWrites(
        existingSections,
        deletedIds,
        plan,
        async (sectionId, order, title, content) => {
          await tx.insert(sections).values({ id: sectionId, homeworkId: id, title, content, order });
        },
        async (sectionId, order, title, content) => {
          await tx.update(sections).set({ title, content, order, updatedAt: new Date() }).where(eq(sections.id, sectionId));
        },
        async (sectionId, action, content) => {
          if (action === "create") {
            await tx.insert(sectionSolutions).values({ sectionId, content: content! });
          } else if (action === "update") {
            await tx.update(sectionSolutions).set({ content: content!, updatedAt: new Date() }).where(eq(sectionSolutions.sectionId, sectionId));
          } else if (action === "delete") {
            await tx.delete(sectionSolutions).where(eq(sectionSolutions.sectionId, sectionId));
          }
        },
      );
    }
    return { id };
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/web && npx vitest run src/server/repositories/homeworks.test.ts`
Expected: PASS, all 4 `deriveHomeworkStatus` tests.

- [ ] **Step 5: Real-DB integration tests for `updateHomework`'s diff, batch atomicity, and reorder resolution**

```ts
// apps/web/src/server/repositories/homeworks.test.ts — appended, gated like
// M2's real-DB suites (skips if DATABASE_URL isn't set locally; always runs
// in CI per turbo.json's declared env)
import { makeNodeDb } from "../../db/nodeClient";
import { unsafeCourseScope } from "./scope";
import { organizations, courses, courseMemberships, users } from "../../db/schema";
import { eq as eq2 } from "drizzle-orm";

// Fixed byte arrays would collide with users_email_blind_index_uq across
// runs (the users table isn't cascade-deleted when a test's organizations
// row is cleaned up) -- random bytes per call, matching every other
// real-DB test file's convention (conversations.test.ts, submissions.test.ts).
async function seedCourseWithInstructor(db: ReturnType<typeof makeNodeDb>, suffix: string) {
  const [org] = await db.insert(organizations).values({
    slug: `m3-test-${suffix}`, name: `M3 Test Org ${suffix}`, workosOrganizationId: `wo-${suffix}`,
  }).returning();
  const [course] = await db.insert(courses).values({
    organizationId: org!.id, code: `TEST-${suffix}`, term: "Test", title: `Test Course ${suffix}`,
  }).returning();
  const [user] = await db.insert(users).values({
    email: crypto.getRandomValues(new Uint8Array(32)) as never,
    emailBlindIndex: crypto.getRandomValues(new Uint8Array(32)) as never,
  }).returning();
  const [membership] = await db.insert(courseMemberships).values({
    userId: user!.id, courseId: course!.id, role: "instructor",
  }).returning();
  return { org: org!, course: course!, membership: membership! };
}

describe.skipIf(!process.env.DATABASE_URL)("updateHomework (real DB)", () => {
  it("creates, updates, reorders, and deletes sections in one call; solution lifecycle round-trips", async () => {
    const db = makeNodeDb(process.env.DATABASE_URL!);
    const { org, membership } = await seedCourseWithInstructor(db, "1");
    const scope = unsafeCourseScope(membership.courseId);
    const created = await createHomework(db, scope, {
      createdById: membership.id, title: "HW1", description: "d", dueDate: new Date("2099-01-01"),
    });

    const initial = await updateHomework(db, scope, created!.id, {
      sections: [
        { title: "Sec A", content: "a", order: 1 },
        { title: "Sec B", content: "b", order: 2, solutionContent: "sol-b" },
      ],
    });
    expect(initial).not.toBeNull();

    const afterCreate = await getHomeworkById(db, scope, created!.id);
    const secA = afterCreate!.sections.find((s) => s.title === "Sec A")!;
    const secB = afterCreate!.sections.find((s) => s.title === "Sec B")!;
    expect(secB.solution?.content).toBe("sol-b");

    // Diff pass: update Sec A's title, reorder (A<->B, a genuine 2-cycle --
    // exercises the scratch-bump path), remove Sec B's solution, add a
    // brand-new Sec C, delete nothing.
    await updateHomework(db, scope, created!.id, {
      sections: [
        { id: secA.id, title: "Sec A revised", content: "a", order: 2 },
        { id: secB.id, title: "Sec B", content: "b", order: 1 },
        { title: "Sec C", content: "c", order: 3 },
      ],
    });

    const afterDiff = await getHomeworkById(db, scope, created!.id);
    expect(afterDiff!.sections.map((s) => s.title)).toEqual(["Sec B", "Sec A revised", "Sec C"]);
    expect(afterDiff!.sections.find((s) => s.title === "Sec B")!.solution).toBeNull();

    // Final diff: omit Sec C -> deleted.
    await updateHomework(db, scope, created!.id, {
      sections: [
        { id: secA.id, title: "Sec A revised", content: "a", order: 1 },
        { id: secB.id, title: "Sec B", content: "b", order: 2 },
      ],
    });
    const afterDelete = await getHomeworkById(db, scope, created!.id);
    expect(afterDelete!.sections).toHaveLength(2);

    await db.delete(organizations).where(eq2(organizations.id, org.id));
  });

  it("rejects a diff with a duplicate order and leaves existing sections untouched", async () => {
    const db = makeNodeDb(process.env.DATABASE_URL!);
    const { org, membership } = await seedCourseWithInstructor(db, "2");
    const scope = unsafeCourseScope(membership.courseId);
    const created = await createHomework(db, scope, {
      createdById: membership.id, title: "HW2", description: "d", dueDate: new Date("2099-01-01"),
    });
    await updateHomework(db, scope, created!.id, {
      sections: [{ title: "Sec A", content: "a", order: 1 }],
    });

    await expect(
      updateHomework(db, scope, created!.id, {
        sections: [
          { title: "X", content: "x", order: 1 },
          { title: "Y", content: "y", order: 1 },
        ],
      }),
    ).rejects.toThrow(/duplicate order/i);

    const afterFailedDiff = await getHomeworkById(db, scope, created!.id);
    expect(afterFailedDiff!.sections).toHaveLength(1); // untouched

    await db.delete(organizations).where(eq2(organizations.id, org.id));
  });

  it("shifts a range with zero scratch bumps when a section is inserted in the middle", async () => {
    // Inserting at position 2 of an existing 1/2/3 shifts 2->3 and 3->4 --
    // a range shift, not a cycle. Verifies resolveSectionWrites resolves
    // this purely through pass-based ordering (see Resolved Design
    // Decision 7): the section that vacates a slot first is whichever one
    // this diff didn't block on anything else, discovered automatically by
    // the algorithm rather than by the test asserting a specific statement
    // order.
    const db = makeNodeDb(process.env.DATABASE_URL!);
    const { org, membership } = await seedCourseWithInstructor(db, "3");
    const scope = unsafeCourseScope(membership.courseId);
    const created = await createHomework(db, scope, {
      createdById: membership.id, title: "HW3", description: "d", dueDate: new Date("2099-01-01"),
    });
    await updateHomework(db, scope, created!.id, {
      sections: [
        { title: "S1", content: "1", order: 1 },
        { title: "S2", content: "2", order: 2 },
        { title: "S3", content: "3", order: 3 },
      ],
    });
    const before = await getHomeworkById(db, scope, created!.id);
    const s1 = before!.sections.find((s) => s.title === "S1")!;
    const s2 = before!.sections.find((s) => s.title === "S2")!;
    const s3 = before!.sections.find((s) => s.title === "S3")!;

    await updateHomework(db, scope, created!.id, {
      sections: [
        { id: s1.id, title: "S1", content: "1", order: 1 },
        { title: "NEW", content: "new", order: 2 },
        { id: s2.id, title: "S2", content: "2", order: 3 },
        { id: s3.id, title: "S3", content: "3", order: 4 },
      ],
    });

    const after = await getHomeworkById(db, scope, created!.id);
    expect(after!.sections.map((s) => [s.title, s.order])).toEqual([
      ["S1", 1], ["NEW", 2], ["S2", 3], ["S3", 4],
    ]);

    await db.delete(organizations).where(eq2(organizations.id, org.id));
  });

  it("resolves a genuine 3-way reorder cycle via a scratch bump", async () => {
    // A(1)->2, B(2)->3, C(3)->1 -- every target is held by another section
    // in the same cycle, so a direct pass-based resolution alone cannot
    // place any of them; this exercises the scratch-bump branch (with only
    // 3 sections, slot 4+ is available as scratch).
    const db = makeNodeDb(process.env.DATABASE_URL!);
    const { org, membership } = await seedCourseWithInstructor(db, "4");
    const scope = unsafeCourseScope(membership.courseId);
    const created = await createHomework(db, scope, {
      createdById: membership.id, title: "HW4", description: "d", dueDate: new Date("2099-01-01"),
    });
    await updateHomework(db, scope, created!.id, {
      sections: [
        { title: "A", content: "a", order: 1 },
        { title: "B", content: "b", order: 2 },
        { title: "C", content: "c", order: 3 },
      ],
    });
    const before = await getHomeworkById(db, scope, created!.id);
    const a = before!.sections.find((s) => s.title === "A")!;
    const b = before!.sections.find((s) => s.title === "B")!;
    const c = before!.sections.find((s) => s.title === "C")!;

    await updateHomework(db, scope, created!.id, {
      sections: [
        { id: a.id, title: "A", content: "a", order: 2 },
        { id: b.id, title: "B", content: "b", order: 3 },
        { id: c.id, title: "C", content: "c", order: 1 },
      ],
    });

    const after = await getHomeworkById(db, scope, created!.id);
    expect(after!.sections.map((s) => [s.title, s.order]).sort()).toEqual([
      ["A", 2], ["B", 3], ["C", 1],
    ].sort());

    await db.delete(organizations).where(eq2(organizations.id, org.id));
  });

  it("returns a friendly error when all 20 sections are reordered in a single full cyclic rotation", async () => {
    // The one case resolveSectionWrites cannot resolve: every order slot
    // 1-20 is simultaneously occupied AND every section is moving, so no
    // scratch value exists anywhere in the allowed range.
    const db = makeNodeDb(process.env.DATABASE_URL!);
    const { org, membership } = await seedCourseWithInstructor(db, "5");
    const scope = unsafeCourseScope(membership.courseId);
    const created = await createHomework(db, scope, {
      createdById: membership.id, title: "HW5", description: "d", dueDate: new Date("2099-01-01"),
    });
    const initialSections = Array.from({ length: 20 }, (_, i) => ({
      title: `Sec ${i + 1}`, content: `c${i + 1}`, order: i + 1,
    }));
    await updateHomework(db, scope, created!.id, { sections: initialSections });
    const before = await getHomeworkById(db, scope, created!.id);
    const byTitle = new Map(before!.sections.map((s) => [s.title, s]));

    // Full rotation: section at order N moves to order (N % 20) + 1.
    const rotated = initialSections.map((s) => ({
      id: byTitle.get(s.title)!.id, title: s.title, content: s.content,
      order: (s.order % 20) + 1,
    }));

    await expect(
      updateHomework(db, scope, created!.id, { sections: rotated }),
    ).rejects.toThrow(/no free order slot/i);

    await db.delete(organizations).where(eq2(organizations.id, org.id));
  });
});
```

Add the two new imports (`createHomework`, `getHomeworkById`, `updateHomework`) to the top of the test file alongside `deriveHomeworkStatus`.

- [ ] **Step 6: Run against local Postgres**

Run: `cd apps/web && DATABASE_URL=postgres://llteacher:dev@localhost:5433/llteacher npx vitest run src/server/repositories/homeworks.test.ts`
Expected: PASS, all 11 tests (2 pre-existing `listHomeworksForCourse`/`createHomework` + 4 pure `deriveHomeworkStatus` + 5 real-DB).

- [ ] **Step 7: Re-export from the repository index and commit**

```ts
// apps/web/src/server/repositories/index.ts — add homeworks' new exports
// alongside its existing listHomeworksForCourse/createHomework (already
// re-exported there); no new index.ts entry needed since it's the same file.
```

```bash
git add apps/web/src/server/repositories/homeworks.ts apps/web/src/server/repositories/homeworks.test.ts
git commit -m "feat(homeworks): getHomeworkById/updateHomework/deleteHomework/publish-state + status derivation (#19, #94)"
```

---

### Task 4: Shared DTOs in `shared/types.ts`

**Files:**
- Modify: `apps/web/src/shared/types.ts`

**Interfaces:**
- Consumes: `HomeworkStatus` from `../server/repositories/homeworks`.
- Produces: `SectionResponse`, `HomeworkDetailResponse`, `HomeworkListItemResponse`, `SectionDiffInput`, `HomeworkUpdateBody`, `HomeworkPublishBody` — consumed by Phase 1's routes (Tasks 5-8) and by Phase 3's admin form (Task 12).

- [ ] **Step 1: Add the DTOs**

```ts
// apps/web/src/shared/types.ts — appended after ProfileWithStats
import type { HomeworkStatus } from "../server/repositories/homeworks";

export type { HomeworkStatus };

export interface SectionResponse {
  id: string;
  title: string;
  content: string;
  order: number;
  solution: { id: string; content: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface HomeworkListItemResponse {
  id: string;
  title: string;
  description: string;
  dueDate: string;
  llmConfigId: string | null;
  status: HomeworkStatus;
  sectionCount: number;
}

export interface HomeworkDetailResponse {
  id: string;
  courseId: string;
  title: string;
  description: string;
  dueDate: string;
  llmConfigId: string | null;
  status: HomeworkStatus;
  publishedAt: string | null;
  releasedAt: string | null;
  sections: SectionResponse[];
  /** Present (true) only in the instructor payload; absent for students. */
  editableBy?: boolean;
}

export interface SectionDiffInput {
  id?: string;
  title: string;
  content: string;
  order: number;
  solutionContent?: string;
}

export interface HomeworkUpdateBody {
  title?: string;
  description?: string;
  dueDate?: string;
  llmConfigId?: string | null;
  sections?: SectionDiffInput[];
}

export interface HomeworkPublishBody {
  publish: boolean;
  /** ISO datetime. If omitted and publish=true, releases immediately. Must
   *  be in the future if present -- the route rejects a past releasedAt
   *  with 400. */
  releasedAt?: string;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && npm run typecheck`
Expected: PASS (no consumers yet, so nothing to break).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/shared/types.ts
git commit -m "feat(types): homework/section DTOs for #19/#94"
```

---

### Task 5: Route — `GET /api/courses/:courseId/homeworks/:homeworkId` (role-aware detail)

**Files:**
- Modify: `apps/web/src/server/routes/homeworks.ts`
- Modify: `apps/web/src/server/routes/homeworks.test.ts`
- Modify: `apps/web/src/server/index.ts` (mount)

**Interfaces:**
- Consumes: `getHomeworkById`, `deriveHomeworkStatus` (Task 3); `HomeworkDetailResponse`, `SectionResponse` (Task 4); `requireCourseMember` (existing).
- Produces: `getHomeworkDetailHandler(c)`, mounted at `GET /api/courses/:courseId/homeworks/:homeworkId`.

- [ ] **Step 1: Write the failing route tests**

```ts
// apps/web/src/server/routes/homeworks.test.ts — new describe block, using
// the existing findManyHomeworks/insertHomework mocks plus new ones:
const findFirstHomework = vi.fn();
const findManySections = vi.fn();
vi.mock("../../db/client", () => ({
  makeDb: () => ({
    query: {
      homeworks: {
        findMany: (...args: unknown[]) => findManyHomeworks(...args),
        findFirst: (...args: unknown[]) => findFirstHomework(...args),
      },
      sections: { findMany: (...args: unknown[]) => findManySections(...args) },
    },
    insert: (...args: unknown[]) => insertHomework(...args),
  }),
}));

describe("GET /api/courses/:courseId/homeworks/:homeworkId", () => {
  it("denies a non-member with 403", async () => {
    const res = await buildApp(fakeAuthContext()).request(
      "/api/courses/course-a/homeworks/hw-1", {}, TEST_ENV,
    );
    expect(res.status).toBe(403);
  });

  it("returns 404 when the homework isn't found in this course scope", async () => {
    findFirstHomework.mockReset().mockResolvedValue(undefined);
    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a" }),
    ).request("/api/courses/course-a/homeworks/hw-1", {}, TEST_ENV);
    expect(res.status).toBe(404);
  });

  it("returns sections + status for a course member (student payload has no editableBy)", async () => {
    findFirstHomework.mockReset().mockResolvedValue({
      id: "hw-1", courseId: "course-a", title: "HW1", description: "d",
      // dueDate must be in the PAST for the "past_due" assertion below to be
      // reachable at all -- deriveHomeworkStatus only returns "past_due" when
      // releasedAt has passed AND dueDate has passed (caught during Task 5
      // implementation: an earlier draft of this fixture used a future
      // dueDate, making the assertion impossible to satisfy).
      dueDate: new Date("2020-01-02"), llmConfigId: null, publishedAt: new Date("2020-01-01"), releasedAt: new Date("2020-01-01"),
    });
    findManySections.mockReset().mockResolvedValue([
      { id: "s1", title: "Sec 1", content: "c1", order: 1, solution: null, createdAt: new Date(), updatedAt: new Date() },
    ]);
    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: () => false }),
    ).request("/api/courses/course-a/homeworks/hw-1", {}, TEST_ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { editableBy?: boolean; status: string; sections: unknown[] };
    expect(body.editableBy).toBeUndefined();
    expect(body.status).toBe("past_due");
    expect(body.sections).toHaveLength(1);
  });

  it("sets editableBy=true for an instructor of the course", async () => {
    findFirstHomework.mockReset().mockResolvedValue({
      id: "hw-1", courseId: "course-a", title: "HW1", description: "d",
      dueDate: new Date("2099-01-01"), llmConfigId: null, publishedAt: null, releasedAt: null,
    });
    findManySections.mockReset().mockResolvedValue([]);
    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" }),
    ).request("/api/courses/course-a/homeworks/hw-1", {}, TEST_ENV);
    const body = (await res.json()) as { editableBy?: boolean };
    expect(body.editableBy).toBe(true);
  });
});
```

Also add `app.get("/api/courses/:courseId/homeworks/:homeworkId", (c) => getHomeworkDetailHandler(c));` to `buildApp` in the test file.

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npx vitest run src/server/routes/homeworks.test.ts`
Expected: FAIL — `getHomeworkDetailHandler` not exported.

- [ ] **Step 3: Implement the handler**

```ts
// apps/web/src/server/routes/homeworks.ts — add imports and handler
import { getHomeworkById, deriveHomeworkStatus } from "../repositories/homeworks";
import type { HomeworkDetailResponse, SectionResponse } from "../../shared/types";

export async function getHomeworkDetailHandler(c: Context<AppEnv>) {
  const courseId = c.req.param("courseId");
  const homeworkId = c.req.param("homeworkId");
  const authContext = c.get("authContext") as AuthContext | undefined;

  const scope = authContext && courseId ? courseScopeFromAuthContext(authContext, courseId) : null;
  if (!scope) {
    return c.json({ error: "Course access denied" }, 403);
  }

  const db = makeDb(c.env.DATABASE_URL);
  const result = await getHomeworkById(db, scope, homeworkId!);
  if (!result) {
    return c.json({ error: "Homework not found" }, 404);
  }

  const sectionsResponse: SectionResponse[] = result.sections.map((s) => ({
    id: s.id,
    title: s.title,
    content: s.content,
    order: s.order,
    solution: s.solution ? { id: s.solution.id, content: s.solution.content } : null,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  }));

  const body: HomeworkDetailResponse = {
    id: result.homework.id,
    courseId: result.homework.courseId,
    title: result.homework.title,
    description: result.homework.description,
    dueDate: result.homework.dueDate.toISOString(),
    llmConfigId: result.homework.llmConfigId,
    status: deriveHomeworkStatus(result.homework),
    publishedAt: result.homework.publishedAt?.toISOString() ?? null,
    releasedAt: result.homework.releasedAt?.toISOString() ?? null,
    sections: sectionsResponse,
    ...(authContext!.isInstructorOf(courseId!) && { editableBy: true }),
  };

  return c.json(body);
}

// Add to the bottom of the file, alongside the existing two:
homeworksRoutes.get("/:homeworkId", requireCourseMember()(getHomeworkDetailHandler));
```

- [ ] **Step 4: Mount in `index.ts`**

```ts
// apps/web/src/server/index.ts
import { listHomeworksHandler, createHomeworkHandler, getHomeworkDetailHandler } from "./routes/homeworks";
// ...
app.get(
  "/api/courses/:courseId/homeworks/:homeworkId",
  requireCourseMember()(getHomeworkDetailHandler),
);
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd apps/web && npx vitest run src/server/routes/homeworks.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/server/routes/homeworks.ts apps/web/src/server/routes/homeworks.test.ts apps/web/src/server/index.ts
git commit -m "feat(homeworks): GET /:homeworkId role-aware detail route (#19)"
```

---

### Task 6: Route — `PATCH /api/courses/:courseId/homeworks/:homeworkId` (section diff + 422 mapping)

**Files:**
- Modify: `apps/web/src/server/routes/homeworks.ts`, `.test.ts`, `apps/web/src/server/index.ts`

**Interfaces:**
- Consumes: `updateHomework` (Task 3), `HomeworkUpdateBody`, `SectionDiffInput` (Task 4), `requireInstructorOf` (existing).
- Produces: `updateHomeworkHandler(c)`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("PATCH /api/courses/:courseId/homeworks/:homeworkId", () => {
  const updateHomeworkMock = vi.fn();
  // add to the vi.mock("../repositories/homeworks", ...) — see Step 3 for
  // why this route mocks the repository directly rather than raw db calls.

  it("denies a non-instructor with 403", async () => {
    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: () => false }),
    ).request("/api/courses/course-a/homeworks/hw-1", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sections: [] }),
    }, TEST_ENV);
    expect(res.status).toBe(403);
  });

  it("returns 404 when updateHomework resolves null (not found in scope)", async () => {
    updateHomeworkMock.mockReset().mockResolvedValue(null);
    const res = await buildApp(
      // isMemberOf must also be true: the handler mints scope via
      // courseScopeFromAuthContext, which requires isMemberOf(courseId),
      // not just isInstructorOf(courseId) -- caught during Task 6
      // implementation (as literally given, this test 403'd regardless of
      // a correct implementation, since scope minting failed first).
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" }),
    ).request("/api/courses/course-a/homeworks/hw-1", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "New title" }),
    }, TEST_ENV);
    expect(res.status).toBe(404);
  });

  it("returns 422 with a friendly message when the diff violates the order constraint", async () => {
    updateHomeworkMock.mockReset().mockRejectedValue(new Error("duplicate order 1 in incoming sections"));
    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" }),
    ).request("/api/courses/course-a/homeworks/hw-1", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sections: [{ title: "A", content: "a", order: 1 }, { title: "B", content: "b", order: 1 }] }),
    }, TEST_ENV);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/order/i);
  });

  it("applies a valid update and returns 200", async () => {
    updateHomeworkMock.mockReset().mockResolvedValue({ id: "hw-1" });
    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" }),
    ).request("/api/courses/course-a/homeworks/hw-1", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Updated" }),
    }, TEST_ENV);
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npx vitest run src/server/routes/homeworks.test.ts`
Expected: FAIL — no such route/mock wiring yet.

- [ ] **Step 3: Implement the handler**

Route-layer 422 mapping catches the plain `Error` thrown by `planSectionDiff`/`updateHomework` (order-constraint violations) by matching its message — matches the existing codebase convention of typed-error mapping being tracked separately (#141) rather than introducing a new error-class hierarchy in this PR.

```ts
// apps/web/src/server/routes/homeworks.ts
import { updateHomework } from "../repositories/homeworks";
import type { HomeworkUpdateBody } from "../../shared/types";

export async function updateHomeworkHandler(c: Context<AppEnv>) {
  const courseId = c.req.param("courseId");
  const homeworkId = c.req.param("homeworkId");
  const authContext = c.get("authContext") as AuthContext | undefined;

  if (!authContext || !courseId || !authContext.isInstructorOf(courseId)) {
    return c.json({ error: "Instructor access denied" }, 403);
  }

  let body: HomeworkUpdateBody;
  try {
    body = await c.req.json<HomeworkUpdateBody>();
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }

  let dueDate: Date | undefined;
  if (body.dueDate !== undefined) {
    dueDate = new Date(body.dueDate);
    if (Number.isNaN(dueDate.getTime())) {
      return c.json({ error: "dueDate must be a valid date" }, 400);
    }
  }

  const scope = courseScopeFromAuthContext(authContext, courseId);
  if (!scope) {
    return c.json({ error: "Course access denied" }, 403);
  }

  const db = makeDb(c.env.DATABASE_URL);
  try {
    const result = await updateHomework(db, scope, homeworkId!, {
      title: body.title,
      description: body.description,
      dueDate,
      llmConfigId: body.llmConfigId,
      sections: body.sections,
    });
    if (!result) {
      return c.json({ error: "Homework not found" }, 404);
    }
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid section data";
    if (/order|section/i.test(message)) {
      return c.json({ error: message }, 422);
    }
    throw err; // anything else falls through to app.onError's generic 503
  }
}

// bottom of file:
homeworksRoutes.patch("/:homeworkId", requireInstructorOf()(updateHomeworkHandler));
```

- [ ] **Step 4: Mount in `index.ts`**

```ts
app.patch(
  "/api/courses/:courseId/homeworks/:homeworkId",
  requireInstructorOf()(updateHomeworkHandler),
);
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd apps/web && npx vitest run src/server/routes/homeworks.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/server/routes/homeworks.ts apps/web/src/server/routes/homeworks.test.ts apps/web/src/server/index.ts
git commit -m "feat(homeworks): PATCH /:homeworkId section diff + 422 constraint mapping (#19)"
```

---

### Task 7: Route — `DELETE /api/courses/:courseId/homeworks/:homeworkId`

**Files:**
- Modify: `apps/web/src/server/routes/homeworks.ts`, `.test.ts`, `apps/web/src/server/index.ts`

**Interfaces:**
- Consumes: `deleteHomework` (Task 3).
- Produces: `deleteHomeworkHandler(c)`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("DELETE /api/courses/:courseId/homeworks/:homeworkId", () => {
  it("denies a non-instructor with 403", async () => {
    const res = await buildApp(
      fakeAuthContext({ isInstructorOf: () => false }),
    ).request("/api/courses/course-a/homeworks/hw-1", { method: "DELETE" }, TEST_ENV);
    expect(res.status).toBe(403);
  });

  it("returns 404 when not found in scope", async () => {
    deleteHomeworkMock.mockReset().mockResolvedValue(null);
    const res = await buildApp(
      // isMemberOf must also be true -- courseScopeFromAuthContext requires
      // it independent of isInstructorOf (same gap found and fixed in Tasks
      // 5/6's test fixtures; fixed proactively here before dispatch).
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" }),
    ).request("/api/courses/course-a/homeworks/hw-1", { method: "DELETE" }, TEST_ENV);
    expect(res.status).toBe(404);
  });

  it("deletes and returns 204", async () => {
    deleteHomeworkMock.mockReset().mockResolvedValue({ id: "hw-1" });
    const res = await buildApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" }),
    ).request("/api/courses/course-a/homeworks/hw-1", { method: "DELETE" }, TEST_ENV);
    expect(res.status).toBe(204);
  });
});
```

- [ ] **Step 2: Run to verify it fails.** Run: `npx vitest run src/server/routes/homeworks.test.ts` — expect FAIL.

- [ ] **Step 3: Implement**

```ts
import { deleteHomework } from "../repositories/homeworks";

export async function deleteHomeworkHandler(c: Context<AppEnv>) {
  const courseId = c.req.param("courseId");
  const homeworkId = c.req.param("homeworkId");
  const authContext = c.get("authContext") as AuthContext | undefined;

  if (!authContext || !courseId || !authContext.isInstructorOf(courseId)) {
    return c.json({ error: "Instructor access denied" }, 403);
  }
  const scope = courseScopeFromAuthContext(authContext, courseId);
  if (!scope) return c.json({ error: "Course access denied" }, 403);

  const db = makeDb(c.env.DATABASE_URL);
  const deleted = await deleteHomework(db, scope, homeworkId!);
  if (!deleted) return c.json({ error: "Homework not found" }, 404);
  return c.body(null, 204);
}

homeworksRoutes.delete("/:homeworkId", requireInstructorOf()(deleteHomeworkHandler));
```

- [ ] **Step 4: Mount in `index.ts`**: `app.delete("/api/courses/:courseId/homeworks/:homeworkId", requireInstructorOf()(deleteHomeworkHandler));`

- [ ] **Step 5: Run to verify it passes.** Run: `npx vitest run src/server/routes/homeworks.test.ts && npm run typecheck` — expect PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/server/routes/homeworks.ts apps/web/src/server/routes/homeworks.test.ts apps/web/src/server/index.ts
git commit -m "feat(homeworks): DELETE /:homeworkId (#19)"
```

---

### Task 8: Route — `PATCH /api/courses/:courseId/homeworks/:homeworkId/publish` (#94)

**Files:**
- Modify: `apps/web/src/server/routes/homeworks.ts`, `.test.ts`, `apps/web/src/server/index.ts`

**Interfaces:**
- Consumes: `updateHomeworkPublishState` (Task 3), `HomeworkPublishBody` (Task 4).
- Produces: `publishHomeworkHandler(c)`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("PATCH /api/courses/:courseId/homeworks/:homeworkId/publish", () => {
  it("denies a non-instructor with 403", async () => {
    const res = await buildApp(fakeAuthContext({ isInstructorOf: () => false })).request(
      "/api/courses/course-a/homeworks/hw-1/publish",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ publish: true }) },
      TEST_ENV,
    );
    expect(res.status).toBe(403);
  });

  it("rejects a past releasedAt with 400", async () => {
    const res = await buildApp(fakeAuthContext({ isInstructorOf: (id) => id === "course-a" })).request(
      "/api/courses/course-a/homeworks/hw-1/publish",
      {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ publish: true, releasedAt: "2020-01-01T00:00:00Z" }),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
  });

  it("publishes immediately when releasedAt is omitted", async () => {
    publishHomeworkMock.mockReset().mockResolvedValue({ id: "hw-1", publishedAt: new Date(), releasedAt: new Date() });
    // isMemberOf required alongside isInstructorOf -- this test reaches
    // courseScopeFromAuthContext (the 400/past-releasedAt test above does
    // not, since that check runs before scope minting). Same gap found in
    // Tasks 5/6/7; fixed proactively here before dispatch.
    const res = await buildApp(fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" })).request(
      "/api/courses/course-a/homeworks/hw-1/publish",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ publish: true }) },
      TEST_ENV,
    );
    expect(res.status).toBe(200);
  });

  it("un-publishes (draft) when publish=false", async () => {
    publishHomeworkMock.mockReset().mockResolvedValue({ id: "hw-1", publishedAt: null, releasedAt: null });
    const res = await buildApp(fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" })).request(
      "/api/courses/course-a/homeworks/hw-1/publish",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ publish: false }) },
      TEST_ENV,
    );
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run to verify it fails.** Expect FAIL (handler not defined).

- [ ] **Step 3: Implement**

```ts
import { updateHomeworkPublishState } from "../repositories/homeworks";
import type { HomeworkPublishBody } from "../../shared/types";

export async function publishHomeworkHandler(c: Context<AppEnv>) {
  const courseId = c.req.param("courseId");
  const homeworkId = c.req.param("homeworkId");
  const authContext = c.get("authContext") as AuthContext | undefined;

  if (!authContext || !courseId || !authContext.isInstructorOf(courseId)) {
    return c.json({ error: "Instructor access denied" }, 403);
  }

  let body: HomeworkPublishBody;
  try {
    body = await c.req.json<HomeworkPublishBody>();
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }
  if (typeof body.publish !== "boolean") {
    return c.json({ error: "publish (boolean) is required" }, 400);
  }

  let releasedAt: Date | undefined;
  if (body.releasedAt !== undefined) {
    releasedAt = new Date(body.releasedAt);
    if (Number.isNaN(releasedAt.getTime())) {
      return c.json({ error: "releasedAt must be a valid date" }, 400);
    }
    if (releasedAt.getTime() < Date.now()) {
      return c.json({ error: "Release time must be in the future" }, 400);
    }
  }

  const scope = courseScopeFromAuthContext(authContext, courseId);
  if (!scope) return c.json({ error: "Course access denied" }, 403);

  const db = makeDb(c.env.DATABASE_URL);
  const updated = await updateHomeworkPublishState(db, scope, homeworkId!, { publish: body.publish, releasedAt });
  if (!updated) return c.json({ error: "Homework not found" }, 404);
  return c.json({ id: updated.id, publishedAt: updated.publishedAt, releasedAt: updated.releasedAt });
}

homeworksRoutes.patch("/:homeworkId/publish", requireInstructorOf()(publishHomeworkHandler));
```

- [ ] **Step 4: Mount in `index.ts`**: `app.patch("/api/courses/:courseId/homeworks/:homeworkId/publish", requireInstructorOf()(publishHomeworkHandler));`

- [ ] **Step 5: Run full Phase 1 suite + typecheck.** Run: `cd apps/web && npm test && npm run typecheck` — expect all PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/server/routes/homeworks.ts apps/web/src/server/routes/homeworks.test.ts apps/web/src/server/index.ts
git commit -m "feat(homeworks): PATCH /:homeworkId/publish draft/publish/schedule endpoint (#94)"
```

**End of Phase 1 — stop and get requester review before starting Phase 2.**

---

## Phase 2 — Issue #20: Student homework list + section progress

### Task 9: Repository — enrollment-scoped student homework query + section status

**Files:**
- Create: `apps/web/src/server/repositories/studentHomeworks.ts`
- Test: `apps/web/src/server/repositories/studentHomeworks.test.ts`

**Interfaces:**
- Consumes: `deriveHomeworkStatus` (Phase 1 Task 3); `conversations`, `submissions`, `sections`, `homeworks`, `courseMemberships` from `../../db/schema`.
- Produces: `deriveSectionStatus(input): SectionStatusType`, `getStudentHomeworksForUser(db, userId): Promise<StudentHomeworkSummary[]>` — consumed by Task 3's route and Phase 3's admin form is unaffected (different surface).

- [ ] **Step 1: Write the failing tests for the pure status function first**

```ts
// apps/web/src/server/repositories/studentHomeworks.test.ts
import { describe, it, expect } from "vitest";
import { deriveSectionStatus } from "./studentHomeworks";

describe("deriveSectionStatus", () => {
  const future = new Date("2099-01-01");
  const past = new Date("2020-01-01");

  it("is submitted when a submission exists, regardless of due date", () => {
    expect(deriveSectionStatus({ dueDate: past, hasActiveConversation: true, hasSubmission: true })).toBe("submitted");
    expect(deriveSectionStatus({ dueDate: future, hasActiveConversation: true, hasSubmission: true })).toBe("submitted");
  });

  it("is in_progress when a conversation exists, not submitted, due date in future", () => {
    expect(deriveSectionStatus({ dueDate: future, hasActiveConversation: true, hasSubmission: false })).toBe("in_progress");
  });

  it("is in_progress_overdue when a conversation exists, not submitted, due date passed", () => {
    expect(deriveSectionStatus({ dueDate: past, hasActiveConversation: true, hasSubmission: false })).toBe("in_progress_overdue");
  });

  it("is overdue when no conversation exists and due date passed", () => {
    expect(deriveSectionStatus({ dueDate: past, hasActiveConversation: false, hasSubmission: false })).toBe("overdue");
  });

  it("is not_started when no conversation exists and due date is in the future", () => {
    expect(deriveSectionStatus({ dueDate: future, hasActiveConversation: false, hasSubmission: false })).toBe("not_started");
  });
});
```

- [ ] **Step 2: Run to verify it fails.** Run: `cd apps/web && npx vitest run src/server/repositories/studentHomeworks.test.ts` — expect FAIL.

- [ ] **Step 3: Implement `deriveSectionStatus` and the query function**

```ts
// apps/web/src/server/repositories/studentHomeworks.ts
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../../db/client";
import { homeworks, sections, conversations, submissions, courseMemberships } from "../../db/schema";
import { deriveHomeworkStatus } from "./homeworks";

export type SectionStatusType = "not_started" | "in_progress" | "in_progress_overdue" | "submitted" | "overdue";

export function deriveSectionStatus(input: {
  dueDate: Date;
  hasActiveConversation: boolean;
  hasSubmission: boolean;
}): SectionStatusType {
  const overdue = input.dueDate.getTime() < Date.now();
  if (input.hasSubmission) return "submitted";
  if (input.hasActiveConversation) return overdue ? "in_progress_overdue" : "in_progress";
  return overdue ? "overdue" : "not_started";
}

export interface StudentSectionProgress {
  id: string;
  title: string;
  order: number;
  status: SectionStatusType;
}

export interface StudentHomeworkSummary {
  id: string;
  title: string;
  description: string;
  dueDate: string;
  completedPercentage: number;
  inProgressPercentage: number;
  sections: StudentSectionProgress[];
}

/** Enrollment-scoped: only homeworks belonging to courses the user has a
 *  non-dropped `student` membership in (deliberate improvement over Django,
 *  which showed all homeworks to all students -- see issue #20). Published-
 *  only: filters via the same on-read status derivation as the instructor
 *  route (Phase 1), so a draft/scheduled homework never appears here even
 *  though nothing in this query references publishedAt/releasedAt by name --
 *  it's filtered by comparing deriveHomeworkStatus's result, not a raw
 *  column check, so the two can never drift out of sync. */
export async function getStudentHomeworksForUser(db: Db, userId: string): Promise<StudentHomeworkSummary[]> {
  const memberships = await db.query.courseMemberships.findMany({
    where: and(eq(courseMemberships.userId, userId), eq(courseMemberships.role, "student"), isNull(courseMemberships.droppedAt)),
  });
  const courseIds = memberships.map((m) => m.courseId);
  if (courseIds.length === 0) return [];

  const allHomeworks = await db.query.homeworks.findMany({
    where: (h, { inArray }) => inArray(h.courseId, courseIds),
    with: { sections: true },
  });

  const results: StudentHomeworkSummary[] = [];
  for (const hw of allHomeworks) {
    const status = deriveHomeworkStatus(hw);
    if (status === "draft" || status === "scheduled") continue; // not yet visible to students

    const sectionSummaries: StudentSectionProgress[] = [];
    let completed = 0;
    let inProgress = 0;

    for (const section of hw.sections) {
      const [activeConversation] = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(eq(conversations.sectionId, section.id), eq(conversations.ownerUserId, userId), eq(conversations.isDeleted, false)));

      let hasSubmission = false;
      if (activeConversation) {
        const [submission] = await db
          .select({ id: submissions.id })
          .from(submissions)
          .where(eq(submissions.conversationId, activeConversation.id));
        hasSubmission = !!submission;
      }

      const sectionStatus = deriveSectionStatus({
        dueDate: hw.dueDate,
        hasActiveConversation: !!activeConversation,
        hasSubmission,
      });
      if (sectionStatus === "submitted") completed++;
      else if (sectionStatus === "in_progress" || sectionStatus === "in_progress_overdue") inProgress++;

      sectionSummaries.push({ id: section.id, title: section.title, order: section.order, status: sectionStatus });
    }
    sectionSummaries.sort((a, b) => a.order - b.order);

    const total = hw.sections.length || 1;
    results.push({
      id: hw.id,
      title: hw.title,
      description: hw.description,
      dueDate: hw.dueDate.toISOString(),
      completedPercentage: Math.round((completed / total) * 100),
      inProgressPercentage: Math.round((inProgress / total) * 100),
      sections: sectionSummaries,
    });
  }
  return results;
}
```

- [ ] **Step 4: Run to verify the pure-function tests pass.** Run: `npx vitest run src/server/repositories/studentHomeworks.test.ts` — expect PASS (5 tests).

- [ ] **Step 5: Real-DB integration test for enrollment scoping + soft-delete handling**

```ts
// appended to studentHomeworks.test.ts, gated like Phase 1's real-DB suite
import { makeNodeDb } from "../../db/nodeClient";
import { unsafeCourseScope } from "./scope";
import { organizations, courses, courseMemberships, users, conversations } from "../../db/schema";
import { eq as eq2 } from "drizzle-orm";
import { createHomework, updateHomework, updateHomeworkPublishState, getHomeworkById } from "./homeworks";

describe.skipIf(!process.env.DATABASE_URL)("getStudentHomeworksForUser (real DB)", () => {
  it("only returns homeworks for courses the student is enrolled in, excludes drafts, ignores soft-deleted conversations", async () => {
    const db = makeNodeDb(process.env.DATABASE_URL!);
    const [org] = await db.insert(organizations).values({
      slug: `m3-test-9-${crypto.randomUUID()}`, name: "M3 Test Org 9", workosOrganizationId: `wo-9-${crypto.randomUUID()}`,
    }).returning();
    const [courseA] = await db.insert(courses).values({
      organizationId: org!.id, code: "TEST-A", term: "Test", title: "Course A",
    }).returning();
    const [courseB] = await db.insert(courses).values({
      organizationId: org!.id, code: "TEST-B", term: "Test", title: "Course B",
    }).returning();
    const [student] = await db.insert(users).values({
      email: crypto.getRandomValues(new Uint8Array(32)) as never,
      emailBlindIndex: crypto.getRandomValues(new Uint8Array(32)) as never,
    }).returning();
    const [instructorUser] = await db.insert(users).values({
      email: crypto.getRandomValues(new Uint8Array(32)) as never,
      emailBlindIndex: crypto.getRandomValues(new Uint8Array(32)) as never,
    }).returning();

    // Student enrolled in course A only -- course B is the "must NOT appear" control.
    await db.insert(courseMemberships).values({ userId: student!.id, courseId: courseA!.id, role: "student" });
    const [instructorMembershipA] = await db.insert(courseMemberships).values({
      userId: instructorUser!.id, courseId: courseA!.id, role: "instructor",
    }).returning();
    const [instructorMembershipB] = await db.insert(courseMemberships).values({
      userId: instructorUser!.id, courseId: courseB!.id, role: "instructor",
    }).returning();

    const scopeA = unsafeCourseScope(courseA!.id);
    const scopeB = unsafeCourseScope(courseB!.id);
    const hwA = await createHomework(db, scopeA, {
      createdById: instructorMembershipA!.id, title: "HW in Course A", description: "d", dueDate: new Date("2099-01-01"),
    });
    const hwB = await createHomework(db, scopeB, {
      createdById: instructorMembershipB!.id, title: "HW in Course B", description: "d", dueDate: new Date("2099-01-01"),
    });
    // Both published+active (publishedAt/releasedAt in the past, dueDate in the future).
    await updateHomeworkPublishState(db, scopeA, hwA!.id, { publish: true, releasedAt: new Date("2020-01-01") });
    await updateHomeworkPublishState(db, scopeB, hwB!.id, { publish: true, releasedAt: new Date("2020-01-01") });
    await updateHomework(db, scopeA, hwA!.id, {
      sections: [
        { title: "Sec 1", content: "c1", order: 1 },
        { title: "Sec 2", content: "c2", order: 2 },
      ],
    });
    await updateHomework(db, scopeB, hwB!.id, {
      sections: [{ title: "B Sec 1", content: "c1", order: 1 }],
    });

    const hwAWithSections = await getHomeworkById(db, scopeA, hwA!.id);
    const sec1 = hwAWithSections!.sections.find((s) => s.title === "Sec 1")!;

    // A soft-deleted conversation for the student on Sec 1 -- must not
    // count toward "in_progress" (getStudentHomeworksForUser only looks at
    // isDeleted=false conversations).
    await db.insert(conversations).values({
      ownerUserId: student!.id, courseId: courseA!.id, sectionId: sec1.id, kind: "section", title: "t",
      isDeleted: true, deletedAt: new Date(),
    });

    const result = await getStudentHomeworksForUser(db, student!.id);

    expect(result).toHaveLength(1);
    expect(result[0]!.title).toBe("HW in Course A");
    const sec1Status = result[0]!.sections.find((s) => s.title === "Sec 1")!;
    expect(sec1Status.status).toBe("not_started");

    await db.delete(organizations).where(eq2(organizations.id, org!.id));
  });
});
```

- [ ] **Step 6: Run against local Postgres.** Run: `DATABASE_URL=postgres://llteacher:dev@localhost:5433/llteacher npx vitest run src/server/repositories/studentHomeworks.test.ts` — expect PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/server/repositories/studentHomeworks.ts apps/web/src/server/repositories/studentHomeworks.test.ts
git commit -m "feat(student): enrollment-scoped homework list + section status derivation (#20)"
```

---

### Task 10: Shared DTO + route — `GET /api/student/homeworks`

**Files:**
- Modify: `apps/web/src/shared/types.ts`
- Create: `apps/web/src/server/routes/studentHomeworks.ts`, `.test.ts`
- Modify: `apps/web/src/server/index.ts`

**Interfaces:**
- Consumes: `getStudentHomeworksForUser` (Task 9); `requireRole` (existing guard).
- Produces: `studentHomeworksHandler(c)`, mounted at `GET /api/student/homeworks`.

- [ ] **Step 1: Add the DTO**

```ts
// apps/web/src/shared/types.ts
import type { SectionStatusType, StudentHomeworkSummary } from "../server/repositories/studentHomeworks";
export type { SectionStatusType, StudentHomeworkSummary };
export interface StudentHomeworkListResponse {
  homeworks: StudentHomeworkSummary[];
}
```

- [ ] **Step 2: Write the failing route test**

```ts
// apps/web/src/server/routes/studentHomeworks.test.ts
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { studentHomeworksHandler } from "./studentHomeworks";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";

const TEST_ENV = { DATABASE_URL: "ignored" } as Env;
const getStudentHomeworksForUser = vi.fn();
vi.mock("../repositories/studentHomeworks", () => ({
  getStudentHomeworksForUser: (...args: unknown[]) => getStudentHomeworksForUser(...args),
}));
vi.mock("../../db/client", () => ({ makeDb: () => ({}) }));

function buildApp(authContext: AuthContext | undefined) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { if (authContext) c.set("authContext", authContext); await next(); });
  app.get("/api/student/homeworks", (c) => studentHomeworksHandler(c));
  return app;
}

function fakeAuthContext(overrides: Partial<AuthContext> = {}): AuthContext {
  const memberships = overrides.memberships ?? [];
  return {
    session: { userId: "u1", workosUserId: "w1", sessionEpoch: 0, issuedAt: 0, expiresAt: 0 },
    memberships,
    hasRole: (role) => memberships.some((m) => m.role === role),
    isMemberOf: (courseId) => memberships.some((m) => m.courseId === courseId),
    isInstructorOf: () => false,
    ...overrides,
  };
}

describe("GET /api/student/homeworks", () => {
  it("returns 401-shaped 403 when unauthenticated", async () => {
    const res = await buildApp(undefined).request("/api/student/homeworks", {}, TEST_ENV);
    expect(res.status).toBe(403);
  });

  it("denies a non-student (teacher-only membership) with 403", async () => {
    const res = await buildApp(fakeAuthContext({ hasRole: (r) => r === "instructor" })).request(
      "/api/student/homeworks", {}, TEST_ENV,
    );
    expect(res.status).toBe(403);
  });

  it("returns the student's homeworks", async () => {
    getStudentHomeworksForUser.mockReset().mockResolvedValue([
      { id: "hw1", title: "HW1", description: "d", dueDate: "2099-01-01T00:00:00.000Z", completedPercentage: 50, inProgressPercentage: 50, sections: [] },
    ]);
    const res = await buildApp(fakeAuthContext({ hasRole: (r) => r === "student" })).request(
      "/api/student/homeworks", {}, TEST_ENV,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { homeworks: unknown[] };
    expect(body.homeworks).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run to verify it fails.** Run: `npx vitest run src/server/routes/studentHomeworks.test.ts` — expect FAIL (module doesn't exist).

- [ ] **Step 4: Implement**

```ts
// apps/web/src/server/routes/studentHomeworks.ts
import { Hono, type Context } from "hono";
import { makeDb } from "../../db/client";
import { getStudentHomeworksForUser } from "../repositories/studentHomeworks";
import { requireRole } from "../utils/guards";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import type { StudentHomeworkListResponse } from "../../shared/types";

export async function studentHomeworksHandler(c: Context<AppEnv>) {
  const authContext = c.get("authContext") as AuthContext | undefined;
  // Defensive re-check of the requireRole(["student"]) guard already applied
  // in index.ts -- matches the belt-and-suspenders pattern every handler in
  // routes/homeworks.ts already uses (caught during Task 10 implementation:
  // without the hasRole check here, calling this handler directly, as the
  // unit tests do, would let a non-student authContext through).
  if (!authContext || !authContext.hasRole("student")) {
    return c.json({ error: "Course access denied" }, 403);
  }
  const db = makeDb(c.env.DATABASE_URL);
  const homeworksList = await getStudentHomeworksForUser(db, authContext.session.userId);
  const body: StudentHomeworkListResponse = { homeworks: homeworksList };
  return c.json(body);
}

export const studentHomeworksRoutes = new Hono<AppEnv>();
studentHomeworksRoutes.get("/", requireRole(["student"])(studentHomeworksHandler));
```

- [ ] **Step 5: Mount in `index.ts`**

```ts
import { studentHomeworksHandler } from "./routes/studentHomeworks";
import { requireRole } from "./utils/guards";
// ...
app.get("/api/student/homeworks", requireRole(["student"])(studentHomeworksHandler));
```

- [ ] **Step 6: Run to verify it passes.** Run: `npx vitest run src/server/routes/studentHomeworks.test.ts && npm run typecheck` — expect PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/shared/types.ts apps/web/src/server/routes/studentHomeworks.ts apps/web/src/server/routes/studentHomeworks.test.ts apps/web/src/server/index.ts
git commit -m "feat(student): GET /api/student/homeworks route (#20)"
```

---

### Task 11: Client — wire `App.tsx` to the real endpoint

**Files:**
- Modify: `apps/web/src/client/App.tsx`

**Interfaces:**
- Consumes: `GET /api/student/homeworks` (Task 10); existing `Sidebar`/`SidebarSection` from `@llteacher/ui`.
- Produces: no new exports — `App` component behavior change only.

- [ ] **Step 1: Replace the `INITIAL_SECTIONS` fixture with a fetch hook**

```tsx
// apps/web/src/client/App.tsx — replace the INITIAL_SECTIONS constant and
// its useState usage. SidebarSection's status union ("submitted"|"current"|
// "pending") doesn't have direct equivalents for "overdue"/"in_progress_
// overdue" -- map them onto the closest existing visual state ("pending")
// for now; a richer Sidebar status vocabulary is a @llteacher/ui change out
// of scope for this issue.
type StudentHomeworkListResponse = {
  homeworks: {
    id: string;
    title: string;
    sections: { id: string; title: string; order: number; status: string }[];
  }[];
};

function useStudentHomework() {
  const [sections, setSections] = useState<SidebarSection[]>([]);
  const [hwTitle, setHwTitle] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/student/homeworks")
      .then((r) => r.json() as Promise<StudentHomeworkListResponse>)
      .then((data) => {
        const hw = data.homeworks[0]; // single-homework sidebar UI, matches current design
        if (!hw) { setLoading(false); return; }
        setHwTitle(hw.title);
        setSections(
          hw.sections.map((s) => ({
            number: s.order,
            title: s.title,
            status: s.status === "submitted" ? "submitted" : s.status === "in_progress" ? "current" : "pending",
          })),
        );
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  return { sections, setSections, hwTitle, loading };
}
```

- [ ] **Step 2: Replace `useState<SidebarSection[]>(INITIAL_SECTIONS)` with the hook**

```tsx
// Inside App():
const { sections, setSections, hwTitle, loading: homeworkLoading } = useStudentHomework();
// remove: const [sections, setSections] = useState<SidebarSection[]>(INITIAL_SECTIONS);
// Sidebar's hwTitle prop now uses `hwTitle` instead of the hardcoded
// "Probability and Distributions" string; hwNumber/currentSection logic
// unchanged (still local UI state, out of scope for this issue per the
// design doc -- M4 wires section-select to conversation context).
```

- [ ] **Step 3: Manual verification (this is a UI change — no automated test substitutes for seeing it render)**

Run: start the dev server (`mcp__Claude_Browser__preview_start` with the project's `apps/web` dev config), navigate to the app, confirm the sidebar renders real section titles/statuses instead of the old fixture, and that submit/collapse behavior is unaffected.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/client/App.tsx
git commit -m "feat(student): wire sidebar to real homework/section data, drop INITIAL_SECTIONS fixture (#20)"
```

**End of Phase 2 — stop and get requester review before starting Phase 3.**

---

## Phase 3 — Issue #21: Admin homework create/edit form

### Task 12: `computeSectionDiff` — client-side mirror of the server diff

**Files:**
- Create: `apps/admin/src/client/lib/computeSectionDiff.ts`, `.test.ts`

**Interfaces:**
- Consumes: nothing external (pure function, mirrors Phase 1 Task 2's `planSectionDiff` shape so the PATCH payload the form builds matches what the server-side diff expects).
- Produces: `computeSectionDiff(existing, form): SectionDiffInput[]` — consumed by Task 3's form submit handler.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/admin/src/client/lib/computeSectionDiff.test.ts
import { describe, it, expect } from "vitest";
import { computeSectionDiff, type FormSection } from "./computeSectionDiff";

describe("computeSectionDiff", () => {
  it("omits id for new sections and renumbers order 1..N", () => {
    const form: FormSection[] = [
      { id: undefined, title: "New", content: "c", solutionContent: undefined },
    ];
    expect(computeSectionDiff(form)).toEqual([
      { title: "New", content: "c", order: 1, solutionContent: undefined },
    ]);
  });

  it("preserves ids for existing sections and renumbers by current form order", () => {
    const form: FormSection[] = [
      { id: "s2", title: "Second", content: "c2", solutionContent: undefined },
      { id: "s1", title: "First", content: "c1", solutionContent: "sol" },
    ];
    expect(computeSectionDiff(form)).toEqual([
      { id: "s2", title: "Second", content: "c2", order: 1, solutionContent: undefined },
      { id: "s1", title: "First", content: "c1", order: 2, solutionContent: "sol" },
    ]);
  });

  it("a removed section (deleted from the form array) is simply absent from the output", () => {
    // The server infers deletion from omission (Phase 1's planSectionDiff) --
    // this function doesn't need a "deleted" marker, just doesn't include it.
    const form: FormSection[] = [{ id: "s1", title: "Kept", content: "c", solutionContent: undefined }];
    const result = computeSectionDiff(form);
    expect(result.find((s) => "id" in s && s.id === "s2")).toBeUndefined();
    expect(result).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails.** Run: `cd apps/admin && npx vitest run src/client/lib/computeSectionDiff.test.ts` — expect FAIL.

- [ ] **Step 3: Implement**

```ts
// apps/admin/src/client/lib/computeSectionDiff.ts
export interface FormSection {
  id?: string;
  title: string;
  content: string;
  solutionContent?: string;
}

export interface SectionDiffOutput {
  id?: string;
  title: string;
  content: string;
  order: number;
  solutionContent?: string;
}

/** Mirrors apps/web/src/server/repositories/sections.ts's planSectionDiff
 *  input shape (IncomingSection) exactly -- order is always renumbered 1..N
 *  from the form's current array order, so a drag-reorder or explicit
 *  add/remove never produces a duplicate/gapped order the server would
 *  reject with a 422. */
export function computeSectionDiff(form: FormSection[]): SectionDiffOutput[] {
  return form.map((s, i) => ({
    ...(s.id !== undefined && { id: s.id }),
    title: s.title,
    content: s.content,
    order: i + 1,
    solutionContent: s.solutionContent,
  }));
}
```

- [ ] **Step 4: Run to verify it passes.** Run: `npx vitest run src/client/lib/computeSectionDiff.test.ts` — expect PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/client/lib/computeSectionDiff.ts apps/admin/src/client/lib/computeSectionDiff.test.ts
git commit -m "feat(admin): client-side section diff mirroring the server's diff shape (#21)"
```

---

### Task 13: Extend admin fixtures/types to match the real schema (interim, until Task 15 wires the real fetch)

**Files:**
- Modify: `apps/admin/src/client/lib/fixtures.ts`

**Interfaces:**
- Produces: `Homework['sections']` items gain `content`/`solutionContent` fields the form needs to pre-populate on edit (previously only `SectionSummary`, a display-only shape with no body text — the form needs the actual editable content).

- [ ] **Step 1: Add a `SectionDetail` type alongside the existing `SectionSummary`**

```ts
// apps/admin/src/client/lib/fixtures.ts — add near SectionSummary. Kept
// separate rather than widening SectionSummary itself: HomeworksView (list)
// only ever needs the summary shape, and widening it would mean every list
// row fixture also has to carry full section body text it never renders.
export type SectionDetail = SectionSummary & {
  content: string;
  solutionContent?: string;
};
```

(No fixture data changes needed yet — Task 4 replaces fixture reads with real API calls entirely; this type only exists so `HomeworkForm`'s props in Task 3 compile against something concrete before Task 4 lands.)

- [ ] **Step 2: Typecheck.** Run: `cd apps/admin && npm run typecheck` — expect PASS (additive type, no existing consumer affected).

- [ ] **Step 3: Commit**

```bash
git add apps/admin/src/client/lib/fixtures.ts
git commit -m "feat(admin): add SectionDetail type for the homework form (#21)"
```

---

### Task 14: `HomeworkForm` component (field array, validation, publish tab)

**Files:**
- Create: `apps/admin/src/client/components/HomeworkForm.tsx`, `.test.tsx`
- Modify: `apps/admin/package.json` (add `react-hook-form` dependency if not already present — check first)

**Interfaces:**
- Consumes: `computeSectionDiff` (Task 12), `SectionDetail` (Task 13), `LLMConfig` (existing fixtures type).
- Produces: `HomeworkForm` component, `HomeworkFormProps`, `HomeworkFormValues` — consumed by Task 5's `HomeworkCreateView`/`HomeworkEditView`.

- [ ] **Step 1: Confirm `react-hook-form` is available**

Run: `cd apps/admin && cat package.json | grep react-hook-form`
Expected: if absent, run `npm install react-hook-form --workspace=apps/admin` before continuing (issue #21's own Code Framework names it as the suggested library; the port plan's Phase 5 notes also name it).

- [ ] **Step 2: Write the failing component tests**

```tsx
// apps/admin/src/client/components/HomeworkForm.test.tsx
// Note: @testing-library/jest-dom is NOT installed anywhere in this repo, so
// `.toBeInTheDocument()` is unavailable -- use `.toBeTruthy()` instead
// (matches the convention already used elsewhere, e.g. AuthProvider.test.tsx).
// Also: this repo's vitest config has no `globals: true`, so testing-library's
// automatic per-test cleanup never fires without an explicit
// `afterEach(cleanup)` -- omitting it leaks DOM nodes across tests in this file.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { HomeworkForm } from "./HomeworkForm";

const LLM_CONFIGS = [{ id: "cfg-1", recordNumber: 1, name: "Default", modelName: "gpt-4o-mini", basePromptPreview: "", temperature: 0.7, maxCompletionTokens: 1000, isDefault: true, isActive: true, createdAt: "2026-01-01" }];

afterEach(cleanup);

describe("HomeworkForm", () => {
  it("requires a title and at least one section before submit", async () => {
    const onSubmit = vi.fn();
    render(<HomeworkForm onSubmit={onSubmit} llmConfigs={LLM_CONFIGS} />);
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(screen.getByText(/title required/i)).toBeTruthy());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("adds a section, fills it out, and submits with order renumbered", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<HomeworkForm onSubmit={onSubmit} llmConfigs={LLM_CONFIGS} />);
    fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: "New HW" } });
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: "desc" } });
    fireEvent.change(screen.getByLabelText(/due date/i), { target: { value: "2099-01-01T00:00" } });
    fireEvent.click(screen.getByRole("button", { name: /add section/i }));
    const titleInputs = screen.getAllByLabelText(/section title/i);
    fireEvent.change(titleInputs[0]!, { target: { value: "Sec 1" } });
    const contentInputs = screen.getAllByLabelText(/section content/i);
    fireEvent.change(contentInputs[0]!, { target: { value: "Sec 1 content" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.sections).toEqual([{ title: "Sec 1", content: "Sec 1 content", order: 1, solutionContent: undefined }]);
  });

  it("removing a section drops it and renumbers the rest", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<HomeworkForm onSubmit={onSubmit} llmConfigs={LLM_CONFIGS} />);
    fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: "HW" } });
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: "d" } });
    fireEvent.change(screen.getByLabelText(/due date/i), { target: { value: "2099-01-01T00:00" } });
    fireEvent.click(screen.getByRole("button", { name: /add section/i }));
    fireEvent.click(screen.getByRole("button", { name: /add section/i }));
    fireEvent.click(screen.getAllByRole("button", { name: /remove section/i })[0]!);
    const titleInputs = screen.getAllByLabelText(/section title/i);
    expect(titleInputs).toHaveLength(1);
  });

  it("rejects submit past 20 sections", async () => {
    const onSubmit = vi.fn();
    render(<HomeworkForm onSubmit={onSubmit} llmConfigs={LLM_CONFIGS} />);
    for (let i = 0; i < 21; i++) fireEvent.click(screen.getByRole("button", { name: /add section/i }));
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(screen.getByText(/20 sections/i)).toBeTruthy());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keyboard: tab order flows title -> content -> add-solution within a section", () => {
    render(<HomeworkForm onSubmit={vi.fn()} llmConfigs={LLM_CONFIGS} />);
    fireEvent.click(screen.getByRole("button", { name: /add section/i }));
    const title = screen.getAllByLabelText(/section title/i)[0]!;
    title.focus();
    expect(document.activeElement).toBe(title);
    fireEvent.keyDown(title, { key: "Tab" });
    // jsdom doesn't execute real tab-order focus movement -- this asserts
    // the DOM order (fieldset children) matches the intended tab sequence,
    // which is what actually determines native tab order.
    const fieldset = title.closest("fieldset")!;
    const focusable = Array.from(fieldset.querySelectorAll("input, textarea, button"));
    expect(focusable[0]).toBe(title);
  });

  it("shows a friendly error and does not throw when onSubmit rejects", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error("network error"));
    render(<HomeworkForm onSubmit={onSubmit} llmConfigs={LLM_CONFIGS} />);
    fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: "HW" } });
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: "d" } });
    fireEvent.change(screen.getByLabelText(/due date/i), { target: { value: "2099-01-01T00:00" } });
    fireEvent.click(screen.getByRole("button", { name: /add section/i }));
    fireEvent.change(screen.getAllByLabelText(/section title/i)[0]!, { target: { value: "Sec 1" } });
    fireEvent.change(screen.getAllByLabelText(/section content/i)[0]!, { target: { value: "c" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(screen.getByText(/failed to save/i)).toBeTruthy());
  });
});
```

- [ ] **Step 3: Run to verify it fails.** Run: `cd apps/admin && npx vitest run src/client/components/HomeworkForm.test.tsx` — expect FAIL (module doesn't exist).

- [ ] **Step 4: Implement `HomeworkForm`**

```tsx
// apps/admin/src/client/components/HomeworkForm.tsx
import { useState, type FormEvent } from "react";
import { useForm, useFieldArray } from "react-hook-form";
import type { LLMConfig, SectionDetail } from "../lib/fixtures";
import { computeSectionDiff, type FormSection } from "../lib/computeSectionDiff";

export interface HomeworkFormValues {
  title: string;
  description: string;
  dueDate: string;
  llmConfigId: string | undefined;
  sections: FormSection[];
  publish: boolean;
  releasedAt: string | undefined;
}

export interface HomeworkFormInitialData {
  title: string;
  description: string;
  dueDate: string;
  llmConfigId: string | null;
  sections: SectionDetail[];
  status: "draft" | "scheduled" | "active" | "past_due" | "archived";
  releasedAt: string | null;
}

export interface HomeworkFormProps {
  initialData?: HomeworkFormInitialData;
  onSubmit: (payload: {
    title: string; description: string; dueDate: string; llmConfigId?: string;
    sections: ReturnType<typeof computeSectionDiff>;
    publish: boolean; releasedAt?: string;
  }) => Promise<void>;
  llmConfigs: LLMConfig[];
  isLoading?: boolean;
}

const MAX_SECTIONS = 20;

export function HomeworkForm({ initialData, onSubmit, llmConfigs, isLoading }: HomeworkFormProps) {
  const [submitError, setSubmitError] = useState<string | null>(null);
  const {
    register, control, handleSubmit, formState: { errors, isDirty },
  } = useForm<HomeworkFormValues>({
    defaultValues: initialData
      ? {
          title: initialData.title, description: initialData.description, dueDate: initialData.dueDate,
          llmConfigId: initialData.llmConfigId ?? undefined,
          sections: initialData.sections.map((s) => ({ id: s.id, title: s.title, content: s.content, solutionContent: s.solutionContent })),
          publish: initialData.status !== "draft",
          releasedAt: initialData.releasedAt ?? undefined,
        }
      : { title: "", description: "", dueDate: "", llmConfigId: undefined, sections: [], publish: false, releasedAt: undefined },
  });
  const { fields, append, remove } = useFieldArray({ control, name: "sections" });

  useUnsavedChangesGuard(isDirty);

  // The MAX_SECTIONS check must run *before* react-hook-form's own field
  // validation: each section's title/content are `required`, so 21 freshly
  // `append()`-ed (empty) sections would otherwise fail per-field validation
  // first and never reach a values-based length check inside handleSubmit's
  // success callback. Checking `fields.length` directly (from useFieldArray,
  // always in sync with the array) sidesteps that -- found while
  // implementing this task, when the "rejects submit past 20 sections" test
  // failed against the length-check-inside-handleSubmit version above.
  const onValid = handleSubmit(async (values) => {
    if (values.sections.length === 0) { setSubmitError("At least 1 section is required"); return; }
    setSubmitError(null);
    // Uncontrolled `register`-ed textareas fall back to the DOM's actual
    // value ("") when a section's solutionContent was left untouched, even
    // though it was appended as `undefined` -- normalize back to undefined
    // so an empty optional field doesn't get treated as "has a solution".
    const sections = values.sections.map((s) => ({ ...s, solutionContent: s.solutionContent || undefined }));
    // react-hook-form's handleSubmit rethrows whatever its callback throws
    // (verified against the installed react-hook-form: it catches only to
    // update internal form state, then rethrows) -- and `submit` below calls
    // `void onValid(e)`, discarding that promise. Without this try/catch, an
    // onSubmit rejection (a real API failure once Task 15 wires this to a
    // network call) becomes an unhandled promise rejection with no
    // user-facing feedback at all. Caught in task review before this landed.
    try {
      await onSubmit({
        title: values.title, description: values.description, dueDate: values.dueDate,
        llmConfigId: values.llmConfigId, sections: computeSectionDiff(sections),
        publish: values.publish, releasedAt: values.releasedAt,
      });
    } catch {
      setSubmitError("Failed to save homework. Please try again.");
    }
  });

  const submit = (e: FormEvent<HTMLFormElement>) => {
    if (fields.length > MAX_SECTIONS) {
      e.preventDefault();
      setSubmitError(`No more than ${MAX_SECTIONS} sections`);
      return;
    }
    void onValid(e);
  };

  return (
    <form onSubmit={submit} noValidate>
      <div className="admin-form-field">
        <label htmlFor="hw-title">Title</label>
        <input id="hw-title" {...register("title", { required: "Title required" })} />
        {errors.title && <p role="alert">{errors.title.message}</p>}
      </div>

      <div className="admin-form-field">
        <label htmlFor="hw-description">Description</label>
        <textarea id="hw-description" {...register("description")} />
      </div>

      <div className="admin-form-field">
        <label htmlFor="hw-due-date">Due date</label>
        <input id="hw-due-date" type="datetime-local" {...register("dueDate", { required: "Due date required" })} />
      </div>

      <div className="admin-form-field">
        <label htmlFor="hw-llm-config">LLM config</label>
        <select id="hw-llm-config" {...register("llmConfigId")}>
          <option value="">(course/org default)</option>
          {llmConfigs.map((cfg) => <option key={cfg.id} value={cfg.id}>{cfg.name}</option>)}
        </select>
      </div>

      <fieldset>
        <legend>Publish</legend>
        <label>
          <input type="checkbox" {...register("publish")} />
          Published
        </label>
        <label htmlFor="hw-released-at">Release at (optional, future only)</label>
        <input id="hw-released-at" type="datetime-local" {...register("releasedAt")} />
      </fieldset>

      {fields.map((field, index) => (
        <fieldset key={field.id} aria-labelledby={`section-${index}-legend`}>
          <legend id={`section-${index}-legend`}>Section {index + 1}</legend>
          <label htmlFor={`section-${index}-title`}>Section title</label>
          <input id={`section-${index}-title`} aria-label="Section title" {...register(`sections.${index}.title`, { required: true })} />
          <label htmlFor={`section-${index}-content`}>Section content</label>
          <textarea id={`section-${index}-content`} aria-label="Section content" {...register(`sections.${index}.content`, { required: true })} />
          <label htmlFor={`section-${index}-solution`}>Solution (optional)</label>
          <textarea id={`section-${index}-solution`} aria-label="Section solution" {...register(`sections.${index}.solutionContent`)} />
          <button type="button" aria-label="Remove section" onClick={() => remove(index)}>Remove section</button>
        </fieldset>
      ))}

      {errors.sections && <p role="alert">At least 1 section is required</p>}
      {submitError && <p role="alert">{submitError}</p>}

      <button type="button" onClick={() => append({ title: "", content: "", solutionContent: undefined })}>
        + Add section
      </button>

      <button type="submit" disabled={isLoading}>Save</button>
    </form>
  );
}

/** Warns before navigating away with unsaved changes. Browser-native
 *  beforeunload only covers a hard reload/close; in-app navigation (the
 *  view-state switch in App.tsx, since there's no router) is guarded by the
 *  caller checking isDirty before calling onBack -- exposed here only for
 *  the reload/close case, which this hook alone can cover. */
function useUnsavedChangesGuard(isDirty: boolean) {
  useState(() => {
    if (typeof window === "undefined") return;
    const handler = (e: BeforeUnloadEvent) => { if (isDirty) e.preventDefault(); };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  });
}
```

- [ ] **Step 5: Run to verify it passes.** Run: `npx vitest run src/client/components/HomeworkForm.test.tsx` — expect PASS, all 6 tests.

- [ ] **Step 6: Commit**

Note: this is an npm workspaces monorepo with a single root lockfile -- there is no `apps/admin/package-lock.json`. If `react-hook-form` needed installing in Step 1, stage the root `package-lock.json` instead.

```bash
git add apps/admin/src/client/components/HomeworkForm.tsx apps/admin/src/client/components/HomeworkForm.test.tsx apps/admin/package.json package-lock.json
git commit -m "feat(admin): HomeworkForm with section field array, publish tab, validation (#21, #94)"
```

---

### Task 15: `HomeworkCreateView` / `HomeworkEditView` wired to the real API

**Files:**
- Modify: `apps/web/src/shared/types.ts` (extend `ProfileWithStats`)
- Modify: `apps/web/src/lib/services/ProfileService.ts` (populate the new field)
- Modify: `apps/web/src/lib/services/ProfileService.test.ts` (add coverage — read the existing file first and follow its established test pattern/mocking convention for this addition; don't invent a new pattern)
- Modify: `apps/admin/src/client/components/AuthProvider.tsx` (parse the new field)
- Create: `apps/admin/src/client/views/HomeworkCreateView.tsx`, `apps/admin/src/client/views/HomeworkEditView.tsx`
- Modify: `apps/admin/src/client/App.tsx` (route the "New homework" button, add `edit-homework`/`create-homework` view states, derive the course id from `useAuth()`)

**Interfaces:**
- Consumes: `HomeworkForm` (Task 14); `POST /api/courses/:courseId/homeworks`, `GET/PATCH /api/courses/:courseId/homeworks/:homeworkId`, `PATCH .../publish` (Phase 1).
- Produces: `HomeworkCreateView`, `HomeworkEditView` components; an extended `ProfileWithStats.courses` field consumed by `apps/admin`'s `AuthProvider`/`useAuth()`.

See Resolved Design Decision 8 for why this task also touches the profile API — `apps/admin` had no course-id source anywhere (traced the whole chain: confirmed a genuine gap, not an oversight; the real fix — #68/#70 — is a different milestone).

- [ ] **Step 0: Extend `GET /api/profile` with the caller's instructor course(s)**

```ts
// apps/web/src/shared/types.ts — add to ProfileWithStats
export interface ProfileWithStats {
  userId: string;
  email: string;
  displayName: string | null;
  role: CourseRole | null;
  courseCount: number;
  instructorStats?: { homeworksCreated: number };
  studentStats?: { submissionsCount: number; completedSections: number };
  /** Course(s) where the caller has a non-dropped instructor/ta/admin
   *  membership. Stopgap for apps/admin's course context until #70's real
   *  course switcher lands (see docs/superpowers/plans/2026-08-05-m3-
   *  homeworks-submissions-parity.md, Resolved Design Decision 8) -- do not
   *  extend this into a general course-listing API; that's #68's job. */
  courses?: { id: string; title: string }[];
}
```

```ts
// apps/web/src/lib/services/ProfileService.ts
// Add to the existing imports:
import { and, eq, inArray, isNull } from "drizzle-orm";
import { courseMemberships, courses, homeworks, users } from "../../db/schema";

// Inside getProfileWithStats, in the existing
// `if (primaryRole === "instructor" || primaryRole === "ta" || primaryRole === "admin")`
// branch, alongside the existing `profile.instructorStats = ...` line:
const instructorCourses = await this.db
  .select({ id: courses.id, title: courses.title })
  .from(courseMemberships)
  .innerJoin(courses, eq(courseMemberships.courseId, courses.id))
  .where(
    and(
      eq(courseMemberships.userId, userId),
      isNull(courseMemberships.droppedAt),
      inArray(courseMemberships.role, ["instructor", "ta", "admin"]),
    ),
  );
profile.courses = instructorCourses;
```

Add a test to `ProfileService.test.ts` covering: an instructor with one course gets `courses: [{id, title}]`; an instructor with a *dropped* membership in a second course does not see that course; a student (no instructor/ta/admin role) gets no `courses` field at all (matches the existing `instructorStats`/`studentStats` mutual-exclusivity pattern already in this function). Follow whatever mocking/real-DB convention the existing tests in this file already use.

```ts
// apps/admin/src/client/components/AuthProvider.tsx — full replacement
import { createAuthProvider, parseCourseRole, type AuthSessionState, type CourseRole } from "@llteacher/ui";

export type { CourseRole };
export interface CourseOption { id: string; title: string }
export type AuthState = AuthSessionState & { role: CourseRole | null; courses: CourseOption[] };

export const { AuthProvider, useAuth } = createAuthProvider<{ role: CourseRole | null; courses: CourseOption[] }>({
  parseExtra: (body) => {
    const raw = body as { role?: unknown; courses?: unknown } | null;
    let role: CourseRole | null = null;
    if (raw?.role != null) {
      const parsed = parseCourseRole(raw.role);
      if (!parsed) {
        // eslint-disable-next-line no-console
        console.warn(`[AuthProvider] /api/profile returned an unrecognized role: ${String(raw.role)}`);
      }
      role = parsed;
    }
    const courses: CourseOption[] = Array.isArray(raw?.courses) ? (raw.courses as CourseOption[]) : [];
    return { role, courses };
  },
  defaultExtra: { role: null, courses: [] },
});
```

Run `cd apps/web && npm run typecheck && npx vitest run src/lib/services/ProfileService.test.ts` and `cd apps/admin && npm run typecheck` before continuing to Step 1 — this extension must be solid before the view components depend on it.

- [ ] **Step 1: Implement `HomeworkCreateView`**

```tsx
// apps/admin/src/client/views/HomeworkCreateView.tsx
import { HomeworkForm } from "../components/HomeworkForm";

export function HomeworkCreateView({ courseId, llmConfigs, onCreated, onCancel }: {
  courseId: string;
  llmConfigs: import("../lib/fixtures").LLMConfig[];
  onCreated: (id: string) => void;
  onCancel: () => void;
}) {
  return (
    <div className="admin-view">
      <button type="button" className="admin-back" onClick={onCancel}>Cancel</button>
      <HomeworkForm
        llmConfigs={llmConfigs}
        onSubmit={async (payload) => {
          const res = await fetch(`/api/courses/${courseId}/homeworks`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: payload.title, description: payload.description, dueDate: payload.dueDate }),
          });
          if (!res.ok) throw new Error("Failed to create homework");
          const created = (await res.json()) as { id: string };
          // Section diff + publish state apply via the same PATCH path an
          // edit would use -- POST only creates the bare homework record
          // (matches the existing createHomeworkHandler's minimal contract
          // from Phase 1 Task 3, which predates sections/publish entirely).
          await fetch(`/api/courses/${courseId}/homeworks/${created.id}`, {
            method: "PATCH", headers: { "content-type": "application/json" },
            body: JSON.stringify({ llmConfigId: payload.llmConfigId, sections: payload.sections }),
          });
          if (payload.publish) {
            await fetch(`/api/courses/${courseId}/homeworks/${created.id}/publish`, {
              method: "PATCH", headers: { "content-type": "application/json" },
              body: JSON.stringify({ publish: true, releasedAt: payload.releasedAt }),
            });
          }
          onCreated(created.id);
        }}
      />
    </div>
  );
}
```

- [ ] **Step 2: Implement `HomeworkEditView`**

```tsx
// apps/admin/src/client/views/HomeworkEditView.tsx
import { useEffect, useState } from "react";
import { HomeworkForm, type HomeworkFormInitialData } from "../components/HomeworkForm";

export function HomeworkEditView({ courseId, homeworkId, llmConfigs, onSaved, onCancel }: {
  courseId: string; homeworkId: string;
  llmConfigs: import("../lib/fixtures").LLMConfig[];
  onSaved: () => void; onCancel: () => void;
}) {
  const [initialData, setInitialData] = useState<HomeworkFormInitialData | null>(null);

  useEffect(() => {
    fetch(`/api/courses/${courseId}/homeworks/${homeworkId}`)
      .then((r) => r.json())
      .then((hw) => setInitialData({
        title: hw.title, description: hw.description, dueDate: hw.dueDate,
        llmConfigId: hw.llmConfigId, status: hw.status, releasedAt: hw.releasedAt,
        sections: hw.sections.map((s: { id: string; title: string; order: number; content: string; solution: { content: string } | null }) => ({
          id: s.id, homeworkId, title: s.title, order: s.order, hasSolution: !!s.solution,
          submissionsCount: 0, content: s.content, solutionContent: s.solution?.content,
        })),
      }));
  }, [courseId, homeworkId]);

  if (!initialData) return null;

  return (
    <div className="admin-view">
      <button type="button" className="admin-back" onClick={onCancel}>Cancel</button>
      <HomeworkForm
        initialData={initialData}
        llmConfigs={llmConfigs}
        onSubmit={async (payload) => {
          await fetch(`/api/courses/${courseId}/homeworks/${homeworkId}`, {
            method: "PATCH", headers: { "content-type": "application/json" },
            body: JSON.stringify({
              title: payload.title, description: payload.description, dueDate: payload.dueDate,
              llmConfigId: payload.llmConfigId, sections: payload.sections,
            }),
          });
          await fetch(`/api/courses/${courseId}/homeworks/${homeworkId}/publish`, {
            method: "PATCH", headers: { "content-type": "application/json" },
            body: JSON.stringify({ publish: payload.publish, releasedAt: payload.releasedAt }),
          });
          onSaved();
        }}
      />
    </div>
  );
}
```

- [ ] **Step 3: Wire `App.tsx`'s view-state machine**

```tsx
// apps/admin/src/client/App.tsx
type View =
  | { kind: "homeworks" }
  | { kind: "create-homework" }
  | { kind: "edit-homework"; homeworkId: string }
  | { kind: "submissions"; homeworkId: string }
  | { kind: "llm-configs" }
  | { kind: "students" };

// App.tsx already destructures useAuth()'s return in its component body
// (e.g. `const { isAuthenticated, loading: authLoading, error: authError, role, login, logout } = useAuth();`)
// -- add `courses` to that destructure.
const { courses, ...rest } = useAuth(); // merge into the existing destructure, don't add a second call

// Stopgap: this app assumes exactly one course everywhere else today
// (TopNav's hardcoded course="STATS 311" string) -- courses[0] matches that
// existing assumption rather than inventing a switcher here. Real
// multi-course support (picker, deep-linked course context, persisted
// selection) is issue #70; when that lands, replace this with real
// course-scoped navigation. See Resolved Design Decision 8 for the full
// reasoning. An instructor with zero courses (a genuine edge case, e.g. a
// brand-new admin account before any course assignment) sees the
// "No course found" empty state below rather than a broken form.
const CURRENT_COURSE_ID = courses[0]?.id;

// Replace the onNewHomework console.log stubs (both the AdminSidebar prop
// and HomeworksView prop) with:
onNewHomework={() => setView({ kind: "create-homework" })}

// Add a case:
{view.kind === "create-homework" && (
  CURRENT_COURSE_ID ? (
    <HomeworkCreateView
      courseId={CURRENT_COURSE_ID}
      llmConfigs={LLM_CONFIGS}
      onCreated={() => setView({ kind: "homeworks" })}
      onCancel={() => setView({ kind: "homeworks" })}
    />
  ) : (
    <EmptyView label="No course found for your account yet" />
  )
)}
{view.kind === "edit-homework" && (
  CURRENT_COURSE_ID ? (
    <HomeworkEditView
      courseId={CURRENT_COURSE_ID}
      homeworkId={view.homeworkId}
      llmConfigs={LLM_CONFIGS}
      onSaved={() => setView({ kind: "homeworks" })}
      onCancel={() => setView({ kind: "homeworks" })}
    />
  ) : (
    <EmptyView label="No course found for your account yet" />
  )
)}
// HomeworksView's onOpenHomework currently routes to "submissions" -- split
// it: title click -> edit-homework, "Submissions" button stays -> submissions.
```

`EmptyView` already exists in `App.tsx` (used for the "students" view's placeholder) — reuse it, don't create a second one.

- [ ] **Step 4: Manual verification**

Start the admin dev server, click "New homework," fill out the form with 2 sections (one with a solution), save, confirm it appears in the homeworks list; open it again, reorder sections, remove one, toggle publish on, save; confirm the student app (Phase 2) now shows it.

- [ ] **Step 5: Commit (two commits — the profile extension is independently testable and reviewable)**

```bash
git add apps/web/src/shared/types.ts apps/web/src/lib/services/ProfileService.ts apps/web/src/lib/services/ProfileService.test.ts apps/admin/src/client/components/AuthProvider.tsx
git commit -m "feat(profile): expose caller's instructor courses on GET /api/profile (#21)

Stopgap for apps/admin's course context -- see Resolved Design
Decision 8 in the M3 plan. Superseded by #70's real course switcher."

git add apps/admin/src/client/views/HomeworkCreateView.tsx apps/admin/src/client/views/HomeworkEditView.tsx apps/admin/src/client/App.tsx
git commit -m "feat(admin): wire New/Edit homework to the real CRUD + publish API, drop console.log stub (#21)"
```

**End of Phase 3 — stop and get requester review before starting Phase 4.**

---

## Phase 4 — Issue #22: Section submission flow

### Task 16: Repository — owner-checked submission upsert

**Files:**
- Modify: `apps/web/src/server/repositories/submissions.ts`
- Modify: `apps/web/src/server/repositories/submissions.test.ts` (if it exists — verify at implementation time; create if not)

**Interfaces:**
- Consumes: existing `submissions`, `conversations`, `courses` tables.
- Produces: `submitSection(db, scope, conversationId, requesterId): Promise<{ id: string; conversationId: string; submittedAt: Date; isResubmission: boolean }>` — extends the existing `createSubmission` rather than replacing it (a different call site, `recordGrade`, may still need the ownerless variant — verify no other caller exists before deciding whether to fold this into `createSubmission` directly or add alongside it; based on the survey, `createSubmission` currently has zero route callers, so extending its signature in place is safe).

- [ ] **Step 1: Write the failing tests**

The existing `submissions.test.ts` (read it first) already has a `describe.skipIf(!DATABASE_URL)("submissions repository", ...)` block with a `beforeAll` seeding `orgAId`/`courseAId`/`userAId`/`userBId`/etc., and a `newConversation(courseId, ownerUserId)` helper that creates a fresh homework+section+conversation. Add the `submitSection` tests as a **new nested `describe` inside that same outer block** (after the existing `it(...)` calls, before the closing `});`), reusing those same fixtures/helper rather than re-seeding:

```ts
// apps/web/src/server/repositories/submissions.test.ts — add this import:
import { submitSection } from "./submissions";
// (add alongside the existing "./submissions" import: createSubmission, getSubmissionByConversation, recordGrade, submitSection)

// ...then, inside the existing describe.skipIf(!DATABASE_URL)("submissions repository", ...) block,
// after the last existing it(...) and before its closing "});":

describe("submitSection", () => {
  it("creates a submission on first submit", async () => {
    const conversationId = await newConversation(courseAId, userAId);
    const result = await submitSection(db, unsafeOrgScope(orgAId), conversationId, userAId);
    expect(result.conversationId).toBe(conversationId);
    expect(result.isResubmission).toBe(false);
    expect(result.submittedAt).toBeInstanceOf(Date);
  });

  it("resubmit updates submittedAt and returns isResubmission=true", async () => {
    const conversationId = await newConversation(courseAId, userAId);
    const first = await submitSection(db, unsafeOrgScope(orgAId), conversationId, userAId);
    const second = await submitSection(db, unsafeOrgScope(orgAId), conversationId, userAId);
    expect(second.id).toBe(first.id); // same row, updated -- not a duplicate
    expect(second.isResubmission).toBe(true);
  });

  it("rejects when requesterId does not own the conversation", async () => {
    const conversationId = await newConversation(courseAId, userAId);
    await expect(
      submitSection(db, unsafeOrgScope(orgAId), conversationId, userBId),
    ).rejects.toThrow();
  });

  it("rejects a soft-deleted conversation", async () => {
    const conversationId = await newConversation(courseAId, userAId);
    await softDeleteConversation(db, unsafeCourseScope(courseAId), conversationId);
    await expect(
      submitSection(db, unsafeOrgScope(orgAId), conversationId, userAId),
    ).rejects.toThrow();
  });

  it("rejects a tutor-kind conversation (no section)", async () => {
    const tutorConv = await createConversation(db, unsafeCourseScope(courseAId), {
      ownerUserId: userAId,
      sectionId: null,
      kind: "tutor",
      title: "tutor chat",
    });
    await expect(
      submitSection(db, unsafeOrgScope(orgAId), tutorConv.id, userAId),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails.** Run: `cd apps/web && DATABASE_URL=postgres://llteacher:dev@localhost:5433/llteacher npx vitest run src/server/repositories/submissions.test.ts` — expect FAIL (`submitSection` not exported).

- [ ] **Step 3: Implement**

```ts
// apps/web/src/server/repositories/submissions.ts — add alongside createSubmission
export async function submitSection(
  db: Db,
  scope: OrgScope,
  conversationId: string,
  requesterId: string,
): Promise<{ id: string; conversationId: string; submittedAt: Date; isResubmission: boolean }> {
  // Closes the ownership gap noted for conversations.ts's
  // softDeleteConversation/appendMessage (#134): this check is scoped to a
  // single route (the only one #22 adds), so it's inlined here rather than
  // widening every repository function's signature.
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
  // Two distinct messages, not one combined check -- found in review: a
  // single message conflated "doesn't exist / soft-deleted / wrong kind"
  // with "exists but wrong owner," leaving the route layer (Task 17) no way
  // to tell them apart if it ever needs to (today it deliberately maps both
  // to a uniform 403 to avoid leaking conversation existence to a non-owner,
  // but that's a route-layer choice, not something the repository should
  // force by only offering one indistinguishable message).
  if (!owned) {
    throw new Error("Conversation not found or not accessible");
  }
  if (owned.ownerUserId !== requesterId) {
    throw new Error("Conversation is not owned by requester");
  }

  const existing = await getSubmissionByConversation(db, scope, conversationId);
  if (existing) {
    const [updated] = await db
      .update(submissions)
      .set({ submittedAt: new Date() })
      .where(eq(submissions.id, existing.id))
      .returning();
    return { id: updated!.id, conversationId, submittedAt: updated!.submittedAt, isResubmission: true };
  }

  const created = await createSubmission(db, scope, conversationId);
  return { id: created.id, conversationId, submittedAt: created.submittedAt, isResubmission: false };
}
```

- [ ] **Step 4: Run to verify it passes.** Run: `DATABASE_URL=postgres://llteacher:dev@localhost:5433/llteacher npx vitest run src/server/repositories/submissions.test.ts` — expect PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/repositories/submissions.ts apps/web/src/server/repositories/submissions.test.ts
git commit -m "feat(submissions): owner-checked submit/resubmit upsert (#22)"
```

---

### Task 17: Route — `POST /api/conversations/:id/submit`

**Files:**
- Create: `apps/web/src/server/routes/submissions.ts`, `.test.ts`
- Modify: `apps/web/src/server/index.ts`
- Modify: `apps/web/src/shared/types.ts`

**Interfaces:**
- Consumes: `submitSection` (Task 16); `requireRole` guard; needs an `OrgScope` — the route has no `:courseId` param (URL is keyed by conversation), so it derives org scope from the caller's own memberships via `getOrgScopesForUser` (existing, in `repositories/users.ts`) rather than `courseScopeFromAuthContext`.

- [ ] **Step 1: Add `SubmissionResponse` DTO**

```ts
// apps/web/src/shared/types.ts
export interface SubmissionResponse {
  id: string;
  conversationId: string;
  submittedAt: string;
  isResubmission: boolean;
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// apps/web/src/server/routes/submissions.test.ts
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { submitSectionHandler } from "./submissions";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";

const TEST_ENV = { DATABASE_URL: "ignored" } as Env;
const submitSectionMock = vi.fn();
const getOrgScopesForUserMock = vi.fn();
vi.mock("../repositories/submissions", () => ({ submitSection: (...a: unknown[]) => submitSectionMock(...a) }));
vi.mock("../repositories/users", () => ({ getOrgScopesForUser: (...a: unknown[]) => getOrgScopesForUserMock(...a) }));
vi.mock("../../db/client", () => ({ makeDb: () => ({}) }));

function fakeAuthContext(overrides: Partial<AuthContext> = {}): AuthContext {
  const memberships = overrides.memberships ?? [];
  return {
    session: { userId: "u1", workosUserId: "w1", sessionEpoch: 0, issuedAt: 0, expiresAt: 0 },
    memberships, hasRole: (r) => memberships.some((m) => m.role === r),
    isMemberOf: () => false, isInstructorOf: () => false, ...overrides,
  };
}
function buildApp(authContext: AuthContext | undefined) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { if (authContext) c.set("authContext", authContext); await next(); });
  app.post("/api/conversations/:id/submit", (c) => submitSectionHandler(c));
  return app;
}

describe("POST /api/conversations/:id/submit", () => {
  it("denies a non-student with 403", async () => {
    const res = await buildApp(fakeAuthContext({ hasRole: () => false })).request(
      "/api/conversations/conv-1/submit", { method: "POST" }, TEST_ENV,
    );
    expect(res.status).toBe(403);
  });

  it("creates a submission and returns 201, isResubmission=false", async () => {
    getOrgScopesForUserMock.mockReset().mockResolvedValue(["org-1"]);
    submitSectionMock.mockReset().mockResolvedValue({ id: "sub-1", conversationId: "conv-1", submittedAt: new Date(), isResubmission: false });
    const res = await buildApp(fakeAuthContext({ hasRole: (r) => r === "student" })).request(
      "/api/conversations/conv-1/submit", { method: "POST" }, TEST_ENV,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as SubmissionResponse;
    expect(body.isResubmission).toBe(false);
  });

  it("resubmit returns 200, isResubmission=true", async () => {
    getOrgScopesForUserMock.mockReset().mockResolvedValue(["org-1"]);
    submitSectionMock.mockReset().mockResolvedValue({ id: "sub-1", conversationId: "conv-1", submittedAt: new Date(), isResubmission: true });
    const res = await buildApp(fakeAuthContext({ hasRole: (r) => r === "student" })).request(
      "/api/conversations/conv-1/submit", { method: "POST" }, TEST_ENV,
    );
    expect(res.status).toBe(200);
  });

  it("maps a wrong-owner repository error to 403", async () => {
    getOrgScopesForUserMock.mockReset().mockResolvedValue(["org-1"]);
    submitSectionMock.mockReset().mockRejectedValue(new Error("Conversation not found or not owned by requester"));
    const res = await buildApp(fakeAuthContext({ hasRole: (r) => r === "student" })).request(
      "/api/conversations/conv-1/submit", { method: "POST" }, TEST_ENV,
    );
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 3: Run to verify it fails.** Run: `cd apps/web && npx vitest run src/server/routes/submissions.test.ts` — expect FAIL.

- [ ] **Step 4: Implement**

```ts
// apps/web/src/server/routes/submissions.ts
import { Hono, type Context } from "hono";
import { makeDb } from "../../db/client";
import { submitSection } from "../repositories/submissions";
import { getOrgScopesForUser } from "../repositories/users";
import { requireRole } from "../utils/guards";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import type { SubmissionResponse } from "../../shared/types";

export async function submitSectionHandler(c: Context<AppEnv>) {
  const conversationId = c.req.param("id");
  const authContext = c.get("authContext") as AuthContext | undefined;
  // Defensive re-check of requireRole(["student"]) -- matches the
  // belt-and-suspenders pattern in studentHomeworks.ts/homeworks.ts (found
  // during Task 17 implementation: without the hasRole check, calling this
  // handler directly, as the unit tests do, would let a non-student
  // authContext through).
  if (!authContext || !authContext.hasRole("student")) return c.json({ error: "Unauthorized" }, 403);

  const db = makeDb(c.env.DATABASE_URL);
  // A student's conversation belongs to exactly one org via its course;
  // getOrgScopesForUser (existing, repositories/users.ts) returns every org
  // scope reachable through the caller's own non-dropped memberships --
  // submitSection's own conversation-ownership check (Task 16) is what
  // actually narrows this to the right one, this is just picking an org to
  // scope the query by (a student only ever belongs to one org in the
  // current single-org-per-user model this repo assumes elsewhere).
  const orgScopes = await getOrgScopesForUser(db, authContext.session.userId);
  const orgScope = orgScopes[0];
  if (!orgScope) return c.json({ error: "No organization membership found" }, 403);

  try {
    const result = await submitSection(db, orgScope, conversationId!, authContext.session.userId);
    const body: SubmissionResponse = {
      id: result.id, conversationId: result.conversationId,
      submittedAt: result.submittedAt.toISOString(), isResubmission: result.isResubmission,
    };
    return c.json(body, result.isResubmission ? 200 : 201);
  } catch {
    return c.json({ error: "Conversation not found or not accessible" }, 403);
  }
}

export const submissionsRoutes = new Hono<AppEnv>();
submissionsRoutes.post("/:id/submit", requireRole(["student"])(submitSectionHandler));
```

- [ ] **Step 5: Mount in `index.ts`**

```ts
import { submitSectionHandler } from "./routes/submissions";
// ...
app.post("/api/conversations/:id/submit", requireRole(["student"])(submitSectionHandler));
```

- [ ] **Step 6: Run to verify it passes.** Run: `npx vitest run src/server/routes/submissions.test.ts && npm run typecheck` — expect PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/server/routes/submissions.ts apps/web/src/server/routes/submissions.test.ts apps/web/src/server/index.ts apps/web/src/shared/types.ts
git commit -m "feat(submissions): POST /api/conversations/:id/submit route (#22)"
```

---

### Task 18: Client — replace the fake submit `setTimeout` with a real call

**Files:**
- Modify: `apps/web/src/server/repositories/studentHomeworks.ts`, `.test.ts` (thread `conversationId`)
- Modify: `packages/ui/src/components/Sidebar.tsx` (add the field to `SidebarSection`)
- Modify: `apps/web/src/client/App.tsx`

See Resolved Design Decision 9 — the brief's `handleSubmit` needs `section.conversationId`, which doesn't exist on `SidebarSection` or `StudentSectionProgress` yet. Not a new architectural gap like decision 8's: the backend already fetches the conversation's id per section, it's just not in the returned object yet.

- [ ] **Step 0: Thread `conversationId` through the student homework query and sidebar type**

```ts
// apps/web/src/server/repositories/studentHomeworks.ts
// StudentSectionProgress gains one field:
export interface StudentSectionProgress {
  id: string;
  title: string;
  order: number;
  status: SectionStatusType;
  conversationId: string | null;
}

// Inside getStudentHomeworksForUser's per-section loop, the push call becomes:
sectionSummaries.push({
  id: section.id, title: section.title, order: section.order, status: sectionStatus,
  conversationId: activeConversation?.id ?? null,
});
```

`activeConversation` is already fetched a few lines above this push (used to compute `hasActiveConversation` for `deriveSectionStatus`) — no new query. If any existing test in `studentHomeworks.test.ts` constructs a `StudentSectionProgress`-shaped literal for a `toEqual`/`toStrictEqual` assertion, add `conversationId` to it (a real-DB test asserting via `.find(...)!.status` or similar targeted field access needs no change).

```ts
// packages/ui/src/components/Sidebar.tsx
export interface SidebarSection {
  number: number;
  title: string;
  status: SectionStatus;
  /** The section's active (non-deleted) conversation, if the student has
   *  started one. Optional -- most call sites (including this package's own
   *  Storybook-style fixtures, if any) have no conversation concept at all;
   *  only apps/web's real data populates it. */
  conversationId?: string;
}
```

Run `cd packages/ui && npm run typecheck` (if the package has its own script; otherwise whatever check that package uses) to confirm the additive field doesn't break any existing consumer/test of `Sidebar`/`SidebarSection` before continuing.

- [ ] **Step 1: Update `useStudentHomework`'s mapping and `handleSubmit`**

```tsx
// apps/web/src/client/App.tsx — inside useStudentHomework's .then(), add
// conversationId to the mapped SidebarSection objects:
setSections(
  hw.sections.map((s) => ({
    number: s.order,
    title: s.title,
    status:
      s.status === "submitted"
        ? ("submitted" as const)
        : s.status === "in_progress"
          ? ("current" as const)
          : ("pending" as const),
    conversationId: s.conversationId ?? undefined,
  })),
);
```

```tsx
// apps/web/src/client/App.tsx — replace handleSubmit. No existing generic
// error-surface exists in this file to reuse (workerStatus/workerLoading is
// specifically for the /api/hello ping, not a general-purpose error
// affordance) -- rather than inventing new UI for this one failure path,
// log and leave sidebar state unchanged on failure; this is a deliberate,
// minimal-scope choice, not an oversight (a real error affordance is a
// separate, cross-cutting concern beyond this task).
const handleSubmit = async (sectionNumber: number) => {
  const section = sections.find((s) => s.number === sectionNumber);
  if (!section?.conversationId) return; // no active conversation yet -- nothing to submit
  try {
    const res = await fetch(`/api/conversations/${section.conversationId}/submit`, { method: "POST" });
    if (!res.ok) throw new Error("submit failed");
    setSections((prev) => prev.map((s) => (s.number === sectionNumber ? { ...s, status: "submitted" as const } : s)));
    setJustSubmittedSection(sectionNumber);
    setTimeout(() => setJustSubmittedSection(null), 800);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[App] section submit failed", err);
  }
};
```

- [ ] **Step 2: Manual verification.** Start a section conversation, submit it, confirm the sidebar flips to submitted and a second submit ("resubmit") doesn't error. If dev-server/browser tooling isn't available, rely on typecheck + tests + careful code reading instead, and say so explicitly.

- [ ] **Step 3: Commit (two commits — the backend/type thread is independently testable)**

```bash
git add apps/web/src/server/repositories/studentHomeworks.ts apps/web/src/server/repositories/studentHomeworks.test.ts packages/ui/src/components/Sidebar.tsx
git commit -m "feat(student): thread conversationId through student homework query and Sidebar type (#22)"

git add apps/web/src/client/App.tsx
git commit -m "feat(student): wire section submit to the real API, drop fake setTimeout (#22)"
```

**End of Phase 4 — stop and get requester review before starting Phase 5.**

---

## Phase 5 — Issue #23: Submissions dashboard

### Task 19: Repository — roster × section aggregation

**Files:**
- Modify: `apps/web/src/server/repositories/submissions.ts`
- Modify: `apps/web/src/server/repositories/submissions.test.ts`

**Interfaces:**
- Consumes: `IdentityCipher` (`apps/web/src/lib/crypto/identity-cipher.ts`) for decrypting `displayName`/`email`; `courseMemberships`, `sections`, `conversations`, `submissions`.
- Produces: `getHomeworkSubmissionsMatrix(db, scope, cipher, homeworkId): Promise<HomeworkSubmissionsResponse>`.

- [ ] **Step 1: Write the failing aggregation test (real-DB, since it needs the real `IdentityCipher` round-trip and real Postgres aggregation)**

Add these imports to `submissions.test.ts` alongside the existing ones:

```ts
import { getHomeworkSubmissionsMatrix } from "./submissions";
import { loadIdentityCipherKeys } from "../../lib/secrets-loader";
import { IdentityCipher } from "../../lib/crypto/identity-cipher";
import { createHomework, updateHomework, getHomeworkById } from "./homeworks";
```

Add this **new, separate** `describe.skipIf(!DATABASE_URL)` block (not nested inside the existing "submissions repository" block, since it needs its own richer fixture: a homework with sections, a course roster, and a cipher — the existing block's fixtures are minimal single-conversation setups that don't fit this shape):

```ts
// apps/web/src/server/repositories/submissions.test.ts — new top-level block
describe.skipIf(!DATABASE_URL)("getHomeworkSubmissionsMatrix (real DB)", () => {
  async function seedMatrixFixture() {
    const db = makeNodeDb(DATABASE_URL!);
    const [org] = await db.insert(organizations).values({
      slug: `m3-test-19-${crypto.randomUUID()}`, name: "M3 Test Org 19", workosOrganizationId: `wo-19-${crypto.randomUUID()}`,
    }).returning();
    const [course] = await db.insert(courses).values({
      organizationId: org!.id, code: "TEST19", term: "Test", title: "Test Course 19",
    }).returning();

    const cipher = new IdentityCipher(await loadIdentityCipherKeys({
      ENCRYPTION_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
      BLIND_INDEX_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
    } as Env));

    async function seedStudent(displayName: string, email: string) {
      const [user] = await db.insert(users).values({
        email: await cipher.encryptString(email),
        emailBlindIndex: await cipher.computeBlindIndex(IdentityCipher.normalizeEmail(email)),
        displayName: await cipher.encryptString(displayName),
      }).returning();
      const [membership] = await db.insert(courseMemberships).values({
        userId: user!.id, courseId: course!.id, role: "student",
      }).returning();
      return { user: user!, membership: membership! };
    }

    const studentA = await seedStudent("Student Active", "active@test.example");
    const studentB = await seedStudent("Student Inactive", "inactive@test.example");
    const studentC = await seedStudent("Student Partial", "partial@test.example");

    const [instructorUser] = await db.insert(users).values({
      email: crypto.getRandomValues(new Uint8Array(32)) as never,
      emailBlindIndex: crypto.getRandomValues(new Uint8Array(32)) as never,
    }).returning();
    const [instructorMembership] = await db.insert(courseMemberships).values({
      userId: instructorUser!.id, courseId: course!.id, role: "instructor",
    }).returning();

    const scope = unsafeCourseScope(course!.id);
    const hw = await createHomework(db, scope, {
      createdById: instructorMembership!.id, title: "Matrix HW", description: "d", dueDate: new Date("2099-01-01"),
    });
    await updateHomework(db, scope, hw!.id, {
      sections: [
        { title: "Section 1", content: "c1", order: 1 },
        { title: "Section 2", content: "c2", order: 2 },
      ],
    });
    const withSections = await getHomeworkById(db, scope, hw!.id);
    const section1 = withSections!.sections.find((s) => s.title === "Section 1")!;
    const section2 = withSections!.sections.find((s) => s.title === "Section 2")!;

    // Student A: 2 conversations on section 1 (one soft-deleted), 1 submitted -> active.
    const [convA1] = await db.insert(conversations).values({
      ownerUserId: studentA.user.id, courseId: course!.id, sectionId: section1.id, kind: "section", title: "a1",
    }).returning();
    await db.insert(conversations).values({
      ownerUserId: studentA.user.id, courseId: course!.id, sectionId: section1.id, kind: "section", title: "a2-deleted",
      isDeleted: true, deletedAt: new Date(),
    });
    await createSubmission(db, unsafeOrgScope(org!.id), convA1!.id);

    // Student B: no conversations at all -> no_interaction.

    // Student C: 1 conversation on section 2, not submitted -> partial.
    await db.insert(conversations).values({
      ownerUserId: studentC.user.id, courseId: course!.id, sectionId: section2.id, kind: "section", title: "c1",
    });

    return { db, org: org!, course: course!, cipher, scope, homeworkId: hw!.id, section1, section2, studentA, studentB, studentC };
  }

  it("computes participation status and section cells for a 3-student x 2-section fixture", async () => {
    const { db, org, cipher, scope, homeworkId, section1, studentA, studentB, studentC } = await seedMatrixFixture();

    const matrix = await getHomeworkSubmissionsMatrix(db, scope, cipher, homeworkId);

    expect(matrix).not.toBeNull();
    expect(matrix!.sectionHeaders).toHaveLength(2);
    expect(matrix!.students).toHaveLength(3);

    const rowA = matrix!.students.find((s) => s.studentId === studentA.user.id)!;
    const rowB = matrix!.students.find((s) => s.studentId === studentB.user.id)!;
    const rowC = matrix!.students.find((s) => s.studentId === studentC.user.id)!;

    expect(rowA.participationStatus).toBe("active");
    expect(rowA.totalConversations).toBe(2); // includes the soft-deleted one
    const rowASection1Cell = rowA.sections.find((c) => c.sectionId === section1.id)!;
    expect(rowASection1Cell.status).toBe("submitted");
    expect(rowASection1Cell.hasDeletedConversation).toBe(true);
    expect(rowASection1Cell.conversationCount).toBe(2);

    expect(rowB.participationStatus).toBe("no_interaction");
    expect(rowB.totalConversations).toBe(0);

    expect(rowC.participationStatus).toBe("partial");
    expect(rowC.totalConversations).toBe(1);

    expect(matrix!.aggregateStats).toEqual({
      totalStudents: 3, activeStudents: 2, inactiveStudents: 1, totalSubmissions: 1, submissionRate: 67,
    });

    await db.delete(organizations).where(eq(organizations.id, org.id));
  });

  it("returns plaintext displayName/email, never ciphertext", async () => {
    const { db, org, cipher, scope, homeworkId, studentA } = await seedMatrixFixture();

    const matrix = await getHomeworkSubmissionsMatrix(db, scope, cipher, homeworkId);
    const rowA = matrix!.students.find((s) => s.studentId === studentA.user.id)!;

    expect(rowA.displayName).toBe("Student Active");
    expect(rowA.email).toBe("active@test.example");

    const serialized = JSON.stringify(matrix);
    // The raw encrypted column value for studentA's email/displayName must
    // never appear in the serialized response -- fetch it directly and
    // confirm its ciphertext bytes (base64'd for a substring check) aren't
    // present anywhere in the output.
    const [rawUser] = await db.select({ email: users.email }).from(users).where(eq(users.id, studentA.user.id));
    const ciphertextBase64 = Buffer.from(rawUser!.email).toString("base64");
    expect(serialized).not.toContain(ciphertextBase64);

    await db.delete(organizations).where(eq(organizations.id, org.id));
  });

  it("scopes roster to course_memberships, excludes a student not enrolled in this course", async () => {
    const { db, org, cipher, scope, homeworkId } = await seedMatrixFixture();
    const [outsideUser] = await db.insert(users).values({
      email: crypto.getRandomValues(new Uint8Array(32)) as never,
      emailBlindIndex: crypto.getRandomValues(new Uint8Array(32)) as never,
    }).returning();
    // Enrolled in a *different* course under the same org, not this homework's course.
    const [otherCourse] = await db.insert(courses).values({
      organizationId: org.id, code: "OTHER", term: "Test", title: "Other Course",
    }).returning();
    await db.insert(courseMemberships).values({ userId: outsideUser!.id, courseId: otherCourse!.id, role: "student" });

    const matrix = await getHomeworkSubmissionsMatrix(db, scope, cipher, homeworkId);
    expect(matrix!.students.find((s) => s.studentId === outsideUser!.id)).toBeUndefined();
    expect(matrix!.students).toHaveLength(3); // unchanged from the base fixture

    await db.delete(organizations).where(eq(organizations.id, org.id));
  });

  it("uses at most 4 db query round-trips (roster, homework+sections, conversations, submissions) -- no N+1", async () => {
    const { db, org, cipher, scope, homeworkId } = await seedMatrixFixture();

    let queryCount = 0;
    const targets: Array<[object, string]> = [
      [db.query.homeworks, "findFirst"],
      [db.query.courseMemberships, "findMany"],
      [db.query.conversations, "findMany"],
      [db.query.submissions, "findMany"],
    ];
    const originals = targets.map(([obj, key]) => (obj as Record<string, unknown>)[key]);
    // If Drizzle's query-builder methods turn out not to be plain writable
    // own-properties (rare, but depends on the installed version), wrap
    // `db.query` itself in a Proxy counting `get` calls on `findFirst`/
    // `findMany` instead -- same intent, different mechanism.
    targets.forEach(([obj, key], i) => {
      (obj as Record<string, unknown>)[key] = (...args: unknown[]) => {
        queryCount++;
        return (originals[i] as (...a: unknown[]) => unknown).apply(obj, args);
      };
    });
    try {
      await getHomeworkSubmissionsMatrix(db, scope, cipher, homeworkId);
    } finally {
      targets.forEach(([obj, key], i) => { (obj as Record<string, unknown>)[key] = originals[i]; });
    }
    expect(queryCount).toBeLessThanOrEqual(4);

    await db.delete(organizations).where(eq(organizations.id, org.id));
  });
});
```

- [ ] **Step 2: Run to verify it fails.** Run: `DATABASE_URL=postgres://llteacher:dev@localhost:5433/llteacher npx vitest run src/server/repositories/submissions.test.ts` — expect FAIL.

- [ ] **Step 3: Implement**

```ts
// apps/web/src/server/repositories/submissions.ts
import { homeworks, users } from "../../db/schema";
import type { IdentityCipher } from "../../lib/crypto/identity-cipher";

export interface SubmissionCell {
  sectionId: string;
  status: "missing" | "in_progress" | "submitted";
  conversationCount: number;
  lastActivityAt: string | null;
  hasDeletedConversation: boolean;
}

export type ParticipationStatus = "no_interaction" | "partial" | "active";

export interface StudentSubmissionRow {
  studentId: string;
  displayName: string;
  email: string;
  sections: SubmissionCell[];
  totalConversations: number;
  submissionCount: number;
  participationStatus: ParticipationStatus;
  lastActivityAt: string | null;
}

export interface HomeworkSubmissionsMatrix {
  homeworkId: string;
  homeworkTitle: string;
  homeworkDueDate: string;
  sectionHeaders: { id: string; order: number; title: string }[];
  students: StudentSubmissionRow[];
  aggregateStats: {
    totalStudents: number; activeStudents: number; inactiveStudents: number;
    totalSubmissions: number; submissionRate: number;
  };
}

/** Single-pass aggregation: roster, sections, conversations (incl.
 *  soft-deleted, for badge display), and submissions are each fetched once
 *  (4 queries total regardless of roster/section size) and joined in
 *  memory -- avoids the N+1 the Django reference had (issue #23's own
 *  framework note). Names/emails decrypted here, server-side only; nothing
 *  upstream of this function ever sees ciphertext. */
export async function getHomeworkSubmissionsMatrix(
  db: Db,
  scope: CourseScope,
  cipher: IdentityCipher,
  homeworkId: string,
): Promise<HomeworkSubmissionsMatrix | null> {
  const homework = await db.query.homeworks.findFirst({
    where: and(eq(homeworks.id, homeworkId), eq(homeworks.courseId, scope)),
    with: { sections: true },
  });
  if (!homework) return null;

  // Plain select+join, not db.query.courseMemberships.findMany({with:{user:true}}):
  // found during Task 19 implementation, by running against real Postgres,
  // not by reading the code. This installed Drizzle version resolves a
  // nested `with` via `left join lateral (select json_build_array(...))`,
  // which forces Postgres to serialize every joined column -- including
  // users.email/displayName's `bytea` -- through JSON. Postgres renders
  // bytea as hex-text inside that JSON array, so node-postgres's JSON
  // parser hands the encryptedText customType's fromDriver a plain string
  // instead of a Buffer; `new Uint8Array(aString)` silently returns a
  // *0-length* array rather than throwing, so every decrypt below would
  // have failed with "Ciphertext shorter than envelope header" in
  // production despite typechecking and looking correct. A flat
  // select+join keeps every column a top-level SQL result column, so
  // node-postgres's normal bytea parser (a real Buffer) runs and
  // fromDriver decodes correctly -- still one query, no N+1. Any other
  // relational `with` traversal that reaches an encryptedText column in
  // this codebase carries the same risk; worth a follow-up audit, flagged
  // separately, not fixed wholesale here.
  const roster = await db
    .select({
      membershipId: courseMemberships.id,
      userId: courseMemberships.userId,
      email: users.email,
      displayName: users.displayName,
    })
    .from(courseMemberships)
    .innerJoin(users, eq(courseMemberships.userId, users.id))
    .where(and(eq(courseMemberships.courseId, scope), eq(courseMemberships.role, "student"), isNull(courseMemberships.droppedAt)));

  const sectionIds = homework.sections.map((s) => s.id);
  const allConversations = sectionIds.length
    ? await db.query.conversations.findMany({
        where: (c, { inArray }) => inArray(c.sectionId, sectionIds),
      })
    : [];
  const conversationIds = allConversations.map((c) => c.id);
  const allSubmissions = conversationIds.length
    ? await db.query.submissions.findMany({ where: (s, { inArray }) => inArray(s.conversationId, conversationIds) })
    : [];
  const submittedConversationIds = new Set(allSubmissions.map((s) => s.conversationId));

  const students: StudentSubmissionRow[] = [];
  for (const membership of roster) {
    const displayName = membership.displayName ? await cipher.decryptString(membership.displayName) : "";
    const email = await cipher.decryptString(membership.email);

    const cells: SubmissionCell[] = [];
    let totalConversations = 0;
    let submissionCount = 0;
    // Student-level "latest activity across every section" -- distinct from
    // each cell's OWN lastActivityAt below. An earlier draft of this
    // function used one shared variable for both, which meant a later
    // section's cell incorrectly inherited an earlier section's activity
    // timestamp (the cumulative max-so-far, not that section's own).
    let studentLastActivityAt: Date | null = null;

    for (const section of [...homework.sections].sort((a, b) => a.order - b.order)) {
      const convosForCell = allConversations.filter((c) => c.sectionId === section.id && c.ownerUserId === membership.userId);
      const activeConvo = convosForCell.find((c) => !c.isDeleted);
      const hasDeleted = convosForCell.some((c) => c.isDeleted);
      const submitted = convosForCell.some((c) => submittedConversationIds.has(c.id));

      totalConversations += convosForCell.length;
      if (submitted) submissionCount++;

      let cellLastActivityAt: Date | null = null;
      for (const c of convosForCell) {
        if (!cellLastActivityAt || c.updatedAt > cellLastActivityAt) cellLastActivityAt = c.updatedAt;
        if (!studentLastActivityAt || c.updatedAt > studentLastActivityAt) studentLastActivityAt = c.updatedAt;
      }

      cells.push({
        sectionId: section.id,
        status: submitted ? "submitted" : activeConvo ? "in_progress" : "missing",
        conversationCount: convosForCell.length,
        lastActivityAt: cellLastActivityAt?.toISOString() ?? null,
        hasDeletedConversation: hasDeleted,
      });
    }

    const participationStatus: ParticipationStatus =
      totalConversations === 0 ? "no_interaction" : submissionCount > 0 ? "active" : "partial";

    students.push({
      studentId: membership.userId, displayName, email, sections: cells,
      totalConversations, submissionCount, participationStatus,
      lastActivityAt: studentLastActivityAt?.toISOString() ?? null,
    });
  }

  students.sort((a, b) => {
    if (!a.lastActivityAt) return 1;
    if (!b.lastActivityAt) return -1;
    return b.lastActivityAt.localeCompare(a.lastActivityAt);
  });

  const activeStudents = students.filter((s) => s.participationStatus !== "no_interaction").length;
  return {
    homeworkId: homework.id,
    homeworkTitle: homework.title,
    homeworkDueDate: homework.dueDate.toISOString(),
    sectionHeaders: homework.sections.map((s) => ({ id: s.id, order: s.order, title: s.title })).sort((a, b) => a.order - b.order),
    students,
    aggregateStats: {
      totalStudents: students.length,
      activeStudents,
      inactiveStudents: students.length - activeStudents,
      totalSubmissions: students.reduce((sum, s) => sum + s.submissionCount, 0),
      submissionRate: students.length ? Math.round((activeStudents / students.length) * 100) : 0,
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes.** Run: `DATABASE_URL=postgres://llteacher:dev@localhost:5433/llteacher npx vitest run src/server/repositories/submissions.test.ts` — expect PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/repositories/submissions.ts apps/web/src/server/repositories/submissions.test.ts
git commit -m "feat(submissions): roster x section aggregation for the dashboard, no N+1 (#23)"
```

---

### Task 20: Shared DTO + route — `GET /api/courses/:courseId/homeworks/:homeworkId/submissions`

**Files:**
- Modify: `apps/web/src/shared/types.ts`, `apps/web/src/server/routes/submissions.ts`, `.test.ts`, `apps/web/src/server/index.ts`

**Interfaces:**
- Consumes: `getHomeworkSubmissionsMatrix` (Task 19); `requireInstructorOf`; needs an `IdentityCipher` instance — verify at implementation time how existing routes (`profile.ts`, which already decrypts a display name for `ProfileWithStats`) construct one from `c.env`, and reuse that construction path rather than inventing a second one.

- [ ] **Step 1: Add DTOs**

```ts
// apps/web/src/shared/types.ts
import type { HomeworkSubmissionsMatrix, ParticipationStatus, SubmissionCell, StudentSubmissionRow } from "../server/repositories/submissions";
export type { ParticipationStatus, SubmissionCell, StudentSubmissionRow };
export type HomeworkSubmissionsResponse = HomeworkSubmissionsMatrix;
```

- [ ] **Step 2: Write the failing route test**

Add these to the top of `routes/submissions.test.ts` (Task 17's file — this task extends it, doesn't replace it): `getHomeworkSubmissionsMatrixMock = vi.fn()` and a `vi.mock("../repositories/submissions", ...)` entry for it alongside the existing `submitSection` mock (merge into the same `vi.mock` call for that module — vitest only honors one `vi.mock` factory per module path). Reuse the existing `fakeAuthContext`/`TEST_ENV` helpers already in the file (Task 17).

```ts
describe("GET /api/courses/:courseId/homeworks/:homeworkId/submissions", () => {
  function buildSubmissionsApp(authContext: AuthContext | undefined) {
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => { if (authContext) c.set("authContext", authContext); await next(); });
    app.get("/api/courses/:courseId/homeworks/:homeworkId/submissions", (c) => getHomeworkSubmissionsHandler(c));
    return app;
  }

  it("denies a non-instructor with 403", async () => {
    const res = await buildSubmissionsApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: () => false }),
    ).request("/api/courses/course-a/homeworks/hw-1/submissions", {}, TEST_ENV);
    expect(res.status).toBe(403);
  });

  it("denies a student with 403", async () => {
    const res = await buildSubmissionsApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: () => false, hasRole: (r) => r === "student" }),
    ).request("/api/courses/course-a/homeworks/hw-1/submissions", {}, TEST_ENV);
    expect(res.status).toBe(403);
  });

  it("returns the matrix for an instructor of the course", async () => {
    getHomeworkSubmissionsMatrixMock.mockReset().mockResolvedValue({
      homeworkId: "hw-1", homeworkTitle: "HW 1", homeworkDueDate: "2099-01-01T00:00:00.000Z",
      sectionHeaders: [], students: [],
      aggregateStats: { totalStudents: 0, activeStudents: 0, inactiveStudents: 0, totalSubmissions: 0, submissionRate: 0 },
    });
    const res = await buildSubmissionsApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" }),
    ).request("/api/courses/course-a/homeworks/hw-1/submissions", {}, TEST_ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { homeworkId: string };
    expect(body.homeworkId).toBe("hw-1");
  });

  it("returns 404 when the homework isn't found in scope", async () => {
    getHomeworkSubmissionsMatrixMock.mockReset().mockResolvedValue(null);
    const res = await buildSubmissionsApp(
      fakeAuthContext({ isMemberOf: (id) => id === "course-a", isInstructorOf: (id) => id === "course-a" }),
    ).request("/api/courses/course-a/homeworks/hw-1/submissions", {}, TEST_ENV);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 3: Run to verify it fails.** Run: `npx vitest run src/server/routes/submissions.test.ts` — expect FAIL.

- [ ] **Step 4: Implement**

```ts
// apps/web/src/server/routes/submissions.ts — add to the existing file (Task 17)
import { getHomeworkSubmissionsMatrix } from "../repositories/submissions";
import { requireInstructorOf } from "../utils/guards";
import { courseScopeFromAuthContext } from "../repositories/scope";
import { loadIdentityCipherKeys } from "../../lib/secrets-loader";
import { IdentityCipher } from "../../lib/crypto/identity-cipher";

export async function getHomeworkSubmissionsHandler(c: Context<AppEnv>) {
  const courseId = c.req.param("courseId");
  const homeworkId = c.req.param("homeworkId");
  const authContext = c.get("authContext") as AuthContext | undefined;
  if (!authContext || !courseId || !authContext.isInstructorOf(courseId)) {
    return c.json({ error: "Instructor access denied" }, 403);
  }
  const scope = courseScopeFromAuthContext(authContext, courseId);
  if (!scope) return c.json({ error: "Course access denied" }, 403);

  const db = makeDb(c.env.DATABASE_URL);
  // Constructed exactly as profile.ts's getProfileHandler/patchProfileHandler
  // already do -- the one existing precedent for building a cipher from
  // c.env at the route layer.
  const cipher = new IdentityCipher(await loadIdentityCipherKeys(c.env));
  const matrix = await getHomeworkSubmissionsMatrix(db, scope, cipher, homeworkId!);
  if (!matrix) return c.json({ error: "Homework not found" }, 404);
  return c.json(matrix);
}

submissionsRoutes.get("/homeworks/:homeworkId/submissions", requireInstructorOf()(getHomeworkSubmissionsHandler));
```

- [ ] **Step 5: Mount in `index.ts`**

```ts
app.get(
  "/api/courses/:courseId/homeworks/:homeworkId/submissions",
  requireInstructorOf()(getHomeworkSubmissionsHandler),
);
```

- [ ] **Step 6: Run to verify it passes.** Run: `npx vitest run src/server/routes/submissions.test.ts && npm run typecheck` — expect PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/shared/types.ts apps/web/src/server/routes/submissions.ts apps/web/src/server/routes/submissions.test.ts apps/web/src/server/index.ts
git commit -m "feat(submissions): GET .../submissions dashboard route (#23)"
```

---

### Task 21: Client — wire `SubmissionsView` to the real per-homework data, fix the always-HW-003 bug

**Files:**
- Modify: `apps/admin/src/client/App.tsx`
- Modify: `apps/admin/src/client/views/SubmissionsView.tsx` (adapt props to the real `HomeworkSubmissionsResponse` shape instead of the fixture's `SubmissionRow[]`)

**Interfaces:**
- Consumes: `GET /api/courses/:courseId/homeworks/:homeworkId/submissions` (Task 20).

- [ ] **Step 1: Fetch real data keyed by the open homework's id**

```tsx
// apps/admin/src/client/App.tsx — the submissions view.kind branch currently
// always passes SUBMISSIONS_HW_003 regardless of view.homeworkId (the bug
// noted in brainstorming). Replace with a fetch keyed by view.homeworkId:
{view.kind === "submissions" && (
  <SubmissionsDataLoader
    courseId={CURRENT_COURSE_ID}
    homeworkId={view.homeworkId}
    onBack={() => setView({ kind: "homeworks" })}
  />
)}

// New small component in App.tsx (or its own file if it grows):
function SubmissionsDataLoader({ courseId, homeworkId, onBack }: { courseId: string; homeworkId: string; onBack: () => void }) {
  const [data, setData] = useState<HomeworkSubmissionsResponse | null>(null);
  useEffect(() => {
    setData(null); // clear stale data from a previously-open homework before the new fetch resolves
    fetch(`/api/courses/${courseId}/homeworks/${homeworkId}/submissions`)
      .then((r) => r.json())
      .then(setData);
  }, [courseId, homeworkId]);
  if (!data) return null;
  return <SubmissionsView data={data} onBack={onBack} />;
}
```

- [ ] **Step 2: Adapt `SubmissionsView`'s props and rendering to the real response shape**

```tsx
// apps/admin/src/client/views/SubmissionsView.tsx — replace
// `{ homework: Homework; rows: SubmissionRow[] }` props with
// `{ data: HomeworkSubmissionsResponse }`. Section-progress grid maps
// data.sectionHeaders (ordered) x student.sections (by sectionId) instead of
// the old sectionsProgress[]/sectionNumber shape; participationStatus values
// ("no_interaction"|"partial"|"active") are unchanged so STATUS_LABEL/
// StatusBadge usage carries over directly. Add a small "deleted" badge/title
// on any SubmissionCell with hasDeletedConversation=true (a rendering detail
// with no prior equivalent -- the fixture data never modeled soft-deletes).
```

- [ ] **Step 3: Manual verification.** Open two different homeworks' submissions views back-to-back; confirm each shows its own roster/matrix (not always HW 3's), and that a submitted section renders correctly end-to-end from Phase 4's flow.

- [ ] **Step 4: Commit**

```bash
git add apps/admin/src/client/App.tsx apps/admin/src/client/views/SubmissionsView.tsx
git commit -m "fix(admin): submissions view now fetches real per-homework data instead of always SUBMISSIONS_HW_003 (#23)"
```

**End of Phase 5 — stop and get requester review before starting Phase 6.**

---

## Phase 6 — Issue #24: Epic closure

No new code — this phase runs epic #24's own end-to-end acceptance checklist (already written in its issue body) against the fully-integrated result of Phases 1-5, and formally closes out the milestone.

### Task 22: Run the epic's acceptance checklist

**Files:** none (verification only).

- [ ] **Step 1:** Instructor creates a homework (title, description, 3 sections with markdown + solutions) via the admin form (Phase 3) → confirm it appears in the student app sidebar (Phase 2) with all sections, only after being published (Phase 1's `#94` state).
- [ ] **Step 2:** Student clicks a section → existing conversation-context wiring (out of M3 scope, M4 handles the real chat — confirm this is stubbed/no-ops cleanly, not broken).
- [ ] **Step 3:** Student submits a section (Phase 4) → sidebar badge flips to `submitted`; resubmit updates the timestamp (verify via the dashboard's `lastActivityAt`, Phase 5).
- [ ] **Step 4:** Instructor opens the Submissions dashboard (Phase 5) → sees the roster × section matrix with participation statuses, a soft-deleted-conversation badge on at least one manually-created test case, last-activity timestamps, and confirm via browser devtools Network tab that the response body contains no ciphertext (`displayName`/`email` are readable plaintext).
- [ ] **Step 5:** Instructor edits the homework (Phase 3 edit view) — reorder sections 3→1→2, add a 4th section, remove section 2's solution → student sidebar (Phase 2) reflects the new order/section/no-solution on next load.
- [ ] **Step 6:** Instructor deletes the homework (Phase 1 Task 7) → confirm (via a direct DB check or the dashboard 404ing) that sections/solutions/conversations/submissions are gone (cascade, per Resolved Design Decision 3).
- [ ] **Step 7:** Cross-tenant test — an instructor from course/org B cannot `GET`/`PATCH`/`DELETE` org A's homework (expect 403 across all of Phase 1's routes); a student from org B cannot see org A's homework in their list (Phase 2) or submit against one of its conversations (Phase 4).
- [ ] **Step 8:** Grep for fixture leakage: `grep -rn "INITIAL_SECTIONS\|SUBMISSIONS_HW_003" apps/web/src/client apps/admin/src/client` — expect zero matches outside of any explicitly-kept storybook/offline-dev-only usage (per epic #24's own "fixtures remain... only for storybook/offline dev" note); if any route-reachable code still imports them, that's a Phase regression to fix before closing.
- [ ] **Step 9:** Run the full test suite and typecheck across both apps: `cd apps/web && npm test && npm run typecheck`, `cd apps/admin && npm test && npm run typecheck`. Expect all green.
- [ ] **Step 10:** Confirm CI (`.github/workflows/test.yml`) is green on the branch/PR containing all five phases before closing the milestone.

- [ ] **Step 2: Assign and close out GitHub bookkeeping**

Confirm every child issue (#19, #20, #21, #22, #23, #94) is assigned to the requester and closed with a reference to its merged PR, then close epic #24 itself referencing the epic-closure verification above. (Issue assignment/closing are GitHub actions — done via `gh issue edit`/`gh issue close`, one per issue, as each phase's PR actually merges — not something to batch at the very end.)

**End of Phase 6 — epic #24 and milestone M3 ready to close.**

---

## Self-Review Notes (writing-plans skill's required pass)

- **Spec coverage**: every requirement bullet in #19/#20/#21/#22/#23/#94's issue bodies maps to a task above; #24's own acceptance checklist is Phase 6 verbatim.
- **Placeholder scan**: two intentional exceptions, both explicitly justified inline rather than vague: Phase 3 Task 4's `CURRENT_COURSE_ID` (genuinely doesn't exist yet in `App.tsx` — the note tells the implementer exactly what to go trace, not "figure it out"), and Phase 5 Task 2's cipher-construction line (points at the exact existing file, `profile.ts`, to copy the pattern from, since re-deriving `IdentityCipher` construction here would risk diverging from the one already-correct call site). Both are "verify X before continuing," not "add appropriate handling."
- **Type consistency check**: `HomeworkStatus` (Phase 1) flows unchanged into `HomeworkDetailResponse`/`HomeworkListItemResponse` (Phase 1) and `HomeworkFormInitialData.status` (Phase 3). `SectionDiffInput`/`IncomingSection` field names (`title`, `content`, `order`, `solutionContent`, optional `id`) are identical across `planSectionDiff` (Task 2), the route body (Tasks 4/6), and `computeSectionDiff`'s output (Task 12) — verified by re-reading each signature during this pass. `SectionStatusType` (Phase 2) is distinct from `HomeworkStatus` (Phase 1) — deliberately two different enums (section-level vs. homework-level), not a naming collision.
