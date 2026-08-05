# M3: Homeworks & Submissions Parity — Design

Epic: [#24](https://github.com/uw-ssec/llteacher/issues/24). Child issues: [#19](https://github.com/uw-ssec/llteacher/issues/19) (CRUD + section diff), [#20](https://github.com/uw-ssec/llteacher/issues/20) (student list), [#21](https://github.com/uw-ssec/llteacher/issues/21) (admin form), [#22](https://github.com/uw-ssec/llteacher/issues/22) (submission flow), [#23](https://github.com/uw-ssec/llteacher/issues/23) (submissions dashboard), [#94](https://github.com/uw-ssec/llteacher/issues/94) (draft/publish state).

Each child issue already ships its own detailed Code Framework / Testing Strategy section — this doc does not repeat that content. It records the decisions made in brainstorming that aren't already settled by the issue text or the existing code, plus the facts discovered while surveying the repo that change how the issues should be read.

## Current state (facts, not decisions)

Surveyed `apps/web` (Hono worker + Drizzle) and `apps/admin` (React) on `origin/staging` @ `9e9e3ae`.

- **Schema**: `homeworks` / `sections` / `sectionSolutions` exist with the order CHECK (1–20) and unique `(homeworkId, order)` index already in place. `conversations.sectionId` is **already `onDelete: "cascade"`** — so #19's "decide the conversation FK policy" is not an open schema decision, it's documenting an existing one. `submissions` is 1:1 on `conversations.id` (also cascade). `courseMemberships` (in `identity.ts`) carries role + roster data.
- **Routes**: `routes/homeworks.ts` already has `listHomeworksHandler` + `createHomeworkHandler` (list + create only). No update/delete/get-by-id. Guards are higher-order wrappers (`requireCourseMember()`, `requireInstructorOf()`) from `utils/guards.ts`; routes are mounted directly on `app` in `index.ts` (not `app.route()`, to avoid prefix-stripping breaking a sub-app's `/` handler).
- **Repositories**: no `sections.ts` repo file exists. `homeworks.ts` repo only has `listHomeworksForCourse` + `createHomework`.
- **Types**: `shared/types.ts` has only `HelloResponse` and `ProfileWithStats` — zero Homework/Section/Submission DTOs exist yet.
- **Student client** (`App.tsx`): `INITIAL_SECTIONS` fixture, `handleSubmit` is a local `setTimeout` fake with no API call at all.
- **Admin client**: no create/edit form scaffolding exists anywhere (#21 is greenfield). `App.tsx` has a live bug: `SubmissionsView` is always rendered with `SUBMISSIONS_HW_003`'s fixture regardless of which homework was opened. The fixture `Homework.status` type already has 5 values (`draft|scheduled|active|past_due|archived`) baked into `HomeworksView`/`StatusBadge`, but the real DB schema has no status column at all.
- **Identity**: display name / email are `encryptedText` columns; `IdentityCipher` is the only way to get plaintext. No plaintext PII column exists anywhere.

## Decisions (confirmed with user)

1. **Build order**: `#19 + #94` as one foundation pass → `#20` → `#21` → `#22` → `#23` → `#24` closure. Deviates from the literal order listed at the bottom of #24 (which ends with #94) because #94's own text says it must land "before #19/#20/#21 harden," and #24's own Integration & Verification Strategy section never mentions #94 in its sequencing (added after that section was written). Building the publish-state column and endpoint alongside #19 means #20 and #21 are built against the final `homeworks` contract from day one instead of being retrofitted.
2. **Conversation FK cascade policy (#19)**: keep the existing schema behavior (cascade). Document it in the #19 PR description as the deliberate choice rather than reopening the schema.
3. **Auto-submit-overdue (#22)**: explicitly deferred. No Cloudflare Cron Trigger added in this pass. Documented in the #22 PR description per the issue's own "record the decision" instruction.
4. **Homework status model (#94)**: add `publishedAt: timestamptz | null` and `releasedAt: timestamptz | null` to `homeworks`. Derive `draft | scheduled | active | past_due` on-read (no cron):
   - no `publishedAt` → `draft`
   - `releasedAt` in the future → `scheduled`
   - `releasedAt` passed, `dueDate` in the future → `active`
   - `releasedAt` passed, `dueDate` passed → `past_due`
   - `archived` stays in the shared type as a documented no-op — no issue in this milestone describes what triggers it. Add a code comment at the derivation site pointing to a follow-up issue (to be filed and linked into a future milestone) rather than silently dropping the state. **Do not file the issue without asking first** — issue creation is a visible/shared-state action per this session's action-confirmation rules.

## Per-phase design

### Foundation: #19 + #94

- Migration adds `publishedAt`, `releasedAt` to `homeworks`.
- New `repositories/sections.ts`: the diff algorithm (create/update/delete/reorder + solution lifecycle) as a function called inside a Drizzle `.transaction()` from the homeworks repo's update path — not embedded directly in the route handler.
- Extend `repositories/homeworks.ts`: `getHomeworkById`, `updateHomework` (invokes the diff), `deleteHomework`, `updateHomeworkPublishState`.
- Extend `routes/homeworks.ts`: `PATCH /:id`, `DELETE /:id`, `GET /:id`, `PATCH /:id/publish`. Role-aware `GET` payload (instructor: full + `editableBy`; student: sections + own status, published-only, using the on-read status derivation).
- New DTOs in `shared/types.ts`: `HomeworkResponse`, `SectionResponse`, `SectionDiff`, homework status type.
- 422 mapping for order-constraint/unique-index violations (catch the Drizzle/Postgres error, return a friendly message, not a raw DB error).
- Org-scoping and instructor-of-course (not creator-only) enforced on every mutation, per the issue's stated deliberate improvement over Django.

### #20 — Student list

- New `routes/student-homeworks.ts`: `GET /api/student/homeworks` (+ per-homework progress), enrollment-scoped via `course_memberships`, published-only using the foundation's status derivation, section status enum computed server-side (submission exists → `submitted`; conversation exists (not soft-deleted) → `in_progress`/`in_progress_overdue`; else `not_started`/`overdue` per due date).
- `App.tsx`: replace `INITIAL_SECTIONS` with a real fetch. Keep existing `localStorage` collapse-state key and submit-flash UX — only the data source changes.

### #21 — Admin form

- New `HomeworkForm.tsx` (react-hook-form field array for sections), `HomeworkCreateView.tsx`, `HomeworkEditView.tsx`. Greenfield — nothing existing to extend.
- Client-side `computeSectionDiff()` mirrors the server diff shape so the PATCH payload matches what the route expects.
- Publish tab (from #94): draft/published toggle + optional future release datetime; client converts local time to UTC ISO before POST; server rejects a past `releasedAt` with 400.
- Fix the `console.log`-only "New homework" stub in `App.tsx` / `AdminSidebar` to route to the create view.

### #22 — Submission flow

- New `routes/submissions.ts`: `POST /api/conversations/:id/submit`. Upsert on the conversation's 1:1 submission row (insert or update `submittedAt`), student-only + conversation-owner-only, soft-deleted conversations rejected.
- `App.tsx`: replace the fake `setTimeout` submit handler with a real API call.

### #23 — Submissions dashboard

- Extend `routes/submissions.ts` with `GET /api/homeworks/:id/submissions`: roster from `course_memberships` (not a global user list — deliberate improvement), aggregated in-memory from a small fixed number of queries (roster, conversations, submissions — no per-student N+1). Names/emails decrypted server-side via `IdentityCipher`; ciphertext never leaves the server.
- Fix the `App.tsx` bug where `SubmissionsView` always renders `SUBMISSIONS_HW_003` regardless of which homework is open — wire it to the real per-homework payload.

### #24 — Epic closure

After all five phases land and their own acceptance criteria pass, run the epic's own end-to-end checklist (already written in #24's issue body: create → visible to enrolled student → submit → dashboard reflects it → edit reorders/adds/removes sections → delete cascades → cross-tenant denial → no fixture imports remain) as the final gate before closing the milestone.

## Testing approach

Each phase follows its issue's own "Testing Strategy" section (already detailed per-issue: diff matrix, permission denial, cross-org denial, soft-delete handling, aggregation correctness, etc.). Route tests follow the existing `hello.test.ts` pattern (`vi.mock` on `../../db/client`, throwaway `Hono` app, fake `authContext` middleware matching `homeworks.test.ts`'s existing precedent). Component tests use React Testing Library under `apps/admin`'s `jsdom` vitest environment.

## Explicitly out of scope for this pass

- Auto-submit-overdue scheduled job (#22) — deferred, decision documented in that PR.
- `archived` homework status (#94) — type kept, no route produces it; follow-up issue to be filed (with confirmation) and linked to a future milestone.
- CSV export, pagination on the submissions dashboard (#23) — not requested by any issue in this milestone.
