# M11: Canvas Integration — Implementation Plan

## 2026-09-10 sync check (implementation + epic acceptance pass, pre-PR)

Implemented inline, all in this one session, in the order this doc lays
out below. Full verification before opening the PR: `npm run typecheck`
clean across all 4 packages; `npx vitest run --testTimeout=30000` from
`apps/web` against the local Docker Postgres (`llteacher-test-pg`) with
every migration re-applied from a dropped schema — 104 files / 1984
passed / 8 skipped (pre-existing, unrelated); `apps/admin`'s own suite —
22 files / 257 passed. No live Canvas account was available in this
environment, so the Canvas HTTP layer is exercised only against a mocked
`fetch` (`canvas-api.test.ts`) and mocked `listCanvasEnrollments`
(`CanvasRosterSyncService.test.ts`, against a real Postgres) -- flagged
explicitly, not silently assumed equivalent to a live-Canvas check.

One real defect caught by the DB-gated sync-service tests, not by design
review: `course_memberships_canvas_enrollment_uq` is a GLOBAL unique
index (mirroring Canvas's own platform-wide enrollment ids), not scoped
per course -- an early version of the test fixtures reused literal
`"e1"`/`"e2"` ids across independent test cases and collided for real
against that constraint. Fixed in the tests (a per-test id namespace),
not the service -- the service's behavior on that failure (report a
per-row error, don't fail the whole sync) was already correct.

**Epic #61 acceptance checklist**, re-read against the real code rather
than assumed from this plan's own intent:
- [x] An instructor registers their Canvas token (encrypted, masked,
      auditable) and links a Canvas course
- [x] "Sync from Canvas" populates the roster with pending users who
      claim accounts via WorkOS SSO on first login (reuses roster.ts's
      existing pending-user path -- Design decision #3)
- [x] Re-sync is idempotent; removals and role changes are reflected
      without deleting rows
- [x] A runbook documents token generation, scopes, and quarterly
      refresh (`docs/operations/canvas-token-setup.md`)

Deliberately NOT built, per this plan's own scope boundaries: LTI 1.3
(#58-#60, explicitly deferred by the epic itself), a scheduled/automatic
re-sync (the epic names it optional; this PR ships the manual trigger
only, noted in the runbook), general course-creation UI (course linking
assumes the llteacher course already exists), and WorkOS bulk-invite API
calls (superseded by the reuse decision above).

Two gaps found and fixed during this same pass, before opening the PR:
the admin form collected `expiresAt` but never displayed it or warned
near expiry (#73's own "show expiry state" requirement), and every
token save audited as `credential.canvas_token_set` even on a
replacement. Both fixed with matching test coverage rather than left for
review to catch.

> **For agentic workers:** Implemented **inline in one session**, not via
> subagent-driven-development (explicit user choice for this milestone).
> Scope: GitHub milestone 11 (`M11: Canvas Integration`), issues
> [#73](https://github.com/uw-ssec/llteacher/issues/73),
> [#74](https://github.com/uw-ssec/llteacher/issues/74), epic
> [#61](https://github.com/uw-ssec/llteacher/issues/61). One cohesive PR
> against `staging` (the milestone is two closely-coupled issues, not the
> 20+-issue scale M4's 4-PR split existed to manage).

## 2026-09-10: stack correction before starting

**CLAUDE.md at the repo root describes a Django project and is stale.**
`package.json`'s own description says it plainly: *"Django legacy lives at
apps/, src/, services/ until cutover."* The actual live codebase — where
every M1–M4 PR landed, where #61/#73/#74 name their own file paths, and
where the last 5 commits on `staging` are — is the TypeScript monorepo:

- `apps/web` — Hono API on Cloudflare Workers, Drizzle/Postgres (Neon), the
  student app.
- `apps/admin` — the instructor console (React, no router, tagged-union
  view state in `App.tsx`).
- `packages/ui` — shared types/components between the two.

This plan targets that stack. Test/typecheck commands are `npm run
typecheck` and `npm test` from the repo root (turbo), or `npx vitest run`
from `apps/web/` — **not** `uv run python run_tests.py`, which only runs
the legacy Django suite.

## Context

Issue #61 is the epic. Near-term scope (this milestone, decided
2026-07-28 per `docs/notes/transcript-2026-07-28.md`): institutional
LTI/Canvas API access is blocked on UW-IT/Instructure until ~Sept–Oct, so
instructors self-generate a Canvas API token and paste it into the admin
console instead. LTI 1.3 (#58–#60) is explicitly deferred, out of scope.

**The schema was already scaffolded for this** (migration `0000`,
`apps/web/src/db/schema/identity.ts`) — `organizationCredentials`,
`lmsIntegrations`, `courses.canvasCourseId`,
`courseMemberships.canvasEnrollmentId/canvasRole`, and
`membershipDropReasonEnum.roster_removal` all already exist. This is much
less net-new schema than #73/#74's own "Code Framework" sections assume
(those were written before the schema landed). What's missing is real
gaps, not a guess:

- `organizationCredentials.secretRef` is `NOT NULL` and is used **only**
  as an allowlisted **env-binding name** (`apps/web/src/lib/llm-config.ts`,
  `ALLOWED_SECRET_REF_BINDINGS`) — a platform-deployed Wrangler secret like
  `OPENROUTER_API_KEY`. There is no write path to this table at all today.
  This mechanism is fundamentally unsuited to an instructor-pasted,
  per-org, runtime-supplied Canvas token: it can't be pre-declared as a
  Wrangler secret at deploy time. **Design decision #1 below.**
- `lmsIntegrations.ltiIss/ltiClientId/ltiDeploymentId` are `NOT NULL` —
  every column of the LTI-launch triple. A token-only integration has none
  of these. **Design decision #2.**
- No Canvas API client, no credentials repository/routes, no sync service,
  no admin UI, no runbook. All net-new.
- `roster.ts`'s `upsertCourseMember(s)` is **already the intended landing
  spot** — its own header comment names "a Canvas roster sync (#74/#11x)
  to come" as the third input to the one provisioning pipeline, alongside
  manual add and CSV import. Reuse it; do not fork a parallel write path.

## Explicit scope boundaries

- **No LTI 1.3, no NRPS.** #58–#60 stay untouched.
- **No grade passback.** Named as an explicit non-goal in #61.
- **No new course-creation UI.** Nothing in this codebase creates a
  `courses` row outside `scripts/seed.ts` today; building general course
  creation is a separate, larger feature. Course linking in this plan
  assumes the llteacher course already exists and links an *existing*
  course to a Canvas course id — matching #74's own wording ("map a Canvas
  course to an llteacher course"), not "create one from Canvas."
- **No WorkOS bulk-invite API integration.** See design decision #3 — the
  existing pending-user/first-login reconciliation path already satisfies
  #74's "WorkOS pre-population" requirement without new code.

## Design decisions

**1. Where an instructor-supplied Canvas token actually lives.**
Add a nullable `encryptedSecret` (`encryptedText`) column to
`organizationCredentials`, reusing the *same* AES-256-GCM
`IdentityCipher` primitive already used for PII (`identity-cipher.ts`) —
not a new crypto path, not a real call to a secrets-manager API. Make
`secretRef` nullable. A check constraint enforces exactly one of
`secretRef` / `encryptedSecret` is set per row. The existing
`resolveApiKey`/`ALLOWED_SECRET_REF_BINDINGS` LLM-credential path
(`llm-config.ts`) is untouched — it only ever reads `secretRef` rows, so
provider-credential resolution behavior for chat is unchanged.
`encryptedSecret` is read **only** by the new Canvas API client code.
Masking (first 2 + last 2 chars) is computed from the decrypted plaintext
at response time, never stored, never logged.

**2. `lmsIntegrations`'s LTI columns, for a row with no LTI launch.**
Make `ltiIss`, `ltiClientId`, `ltiDeploymentId` nullable. Replace the
existing `(ltiIss, ltiClientId, ltiDeploymentId)` unique index with a
partial one (`WHERE lti_iss IS NOT NULL`), since near-term rows carry all
three as null and an unqualified unique index would let only one such row
exist per organization. Add `canvasBaseUrl` (text — e.g.
`https://uw.instructure.com`, per-org so this isn't hardcoded to UW, per
#61's own acceptance criterion), `lastSyncStatus` (enum: `idle`,
`syncing`, `success`, `error`), `lastSyncCounts` (jsonb:
`{added,updated,removed}`), `lastSyncErrorMessage` (text). `courses.
lastSyncedAt` already exists and is reused as-is.

**3. WorkOS pre-population — decided by reuse, not new code.**
#74 asks the implementer to decide and record this. The existing
mechanism (`roster.ts`'s `upsertCourseMember(s)` creates a **pending**
`users` row; `UserIdentityService.createOrClaimUser` reconciles it by
`emailBlindIndex` on first WorkOS login) already *is* the
"allow-on-first-login" option, and it's already exercised in production
for manual add, CSV import, and NetID entry. Canvas sync reuses this same
pipeline rather than bulk-inviting synced students into the WorkOS
org. Recorded here as the decision; no WorkOS API code is added.

**4. Sync algorithm — idempotent, three passes, diffed on
`canvasEnrollmentId`.**
1. **Known rows**: enrollments whose id matches an existing
   `courseMemberships.canvasEnrollmentId` → direct `role`/`canvasRole`
   UPDATE (and restore if previously `roster_removal`-dropped). Canvas is
   authoritative for a row it already owns, so this bypasses
   `upsertCourseMembers`'s deliberate "don't auto-promote a role
   conflict" refusal — that refusal exists to protect a *manually*
   curated membership from being silently reassigned, which does not
   apply to a membership sync itself created.
2. **New-to-Canvas rows**: enrollments with no existing
   `canvasEnrollmentId` match → resolved by email through
   `upsertCourseMembers` (creates a pending user + membership, or
   reactivates/confirms a manually-added person now also seen in Canvas),
   then `canvasEnrollmentId`/`canvasRole` stamped onto the resulting
   membership in one batched UPDATE.
3. **Removed rows**: existing active memberships with a
   `canvasEnrollmentId` set that is **not** in this sync's enrollment-id
   set → soft-dropped, `droppedReason: "roster_removal"` (the exact enum
   value `roster.ts`'s manual removal already uses — no new enum member).

Fetch-then-write, not interleaved: every enrollment page is pulled and
held in memory before any write starts, so a mid-fetch failure (pagination
error, token revoked, rate limit) leaves the roster untouched rather than
half-synced. Writes reuse `upsertCourseMembers`'s existing per-row-result
batching, so one bad row is reported, not fatal to the batch.

**5. Canvas role → `course_role` mapping** (documented once, in the sync
service, not re-derived at each call site):

| Canvas `enrollment.type` | `course_role` |
|---|---|
| `TeacherEnrollment` | `instructor` |
| `TaEnrollment` | `ta` |
| `StudentEnrollment` | `student` |
| `ObserverEnrollment` | `observer` |
| `DesignerEnrollment` | `instructor` (closest available — content-authoring access, no direct equivalent role) |
| anything else | skipped, reported as a per-enrollment sync error, not fatal to the run |

**6. Pagination & rate limits.** Canvas paginates via the `Link` response
header (`rel="next"`), not a page-number param — the client follows it
until absent. Canvas signals rate-limiting via `X-Rate-Limit-Remaining`
approaching `0` (not classic HTTP 429); the client checks that header,
and on a `403` whose body says `Rate Limit Exceeded` backs off once with a
short delay and retries a bounded number of times before failing the
whole fetch phase with a stated, stored error.

## Migration

Edit `apps/web/src/db/schema/identity.ts` per decisions #1/#2, then
`cd apps/web && npm run db:generate` to produce the next-numbered
migration (`0046_...sql`) the normal way — not hand-written SQL — so it
matches every other migration's drizzle-kit provenance.

## Files to create/touch

**Schema/migration**
- `apps/web/src/db/schema/identity.ts` — decisions #1/#2.
- `apps/web/src/db/migrations/0046_*.sql` (generated).

**Canvas API client**
- `apps/web/src/lib/canvas-api.ts` (new) — thin client: `validateToken`
  (`GET /api/v1/users/self`), `listCourses` (`GET /api/v1/courses`),
  `listEnrollments` (`GET /api/v1/courses/:id/enrollments`, paginated).
  Takes `baseUrl` + `token` as plain args — never touches the DB or the
  cipher itself, so it's unit-testable with mocked `fetch` alone.
- `apps/web/src/lib/canvas-api.test.ts` (new) — pagination (Link-header
  following, termination on last page), rate-limit backoff/retry, and
  error-shape tests against mocked `fetch`.

**Credential management (#73)**
- `apps/web/src/server/repositories/organizationCredentials.ts` (new) —
  create/replace/delete/get-masked, all org-scoped, all going through
  `encryptedSecret` for provider `canvas`.
- `apps/web/src/server/repositories/organizationCredentials.test.ts` (new).
- `apps/web/src/server/routes/canvasCredentials.ts` (new) — CRUD +
  `/validate`, `requireInstructorOf`-gated like `llmConfigs.ts`, following
  its exact validation/error-shape/audit conventions.
- `apps/web/src/server/routes/canvasCredentials.test.ts` (new).

**Roster sync (#74)**
- `apps/web/src/server/repositories/lmsIntegrations.ts` (new) — link a
  course to a Canvas course id + credential; read sync status.
- `apps/web/src/lib/services/CanvasRosterSyncService.ts` (new) — the
  3-pass algorithm above; calls `roster.ts`'s `upsertCourseMembers`, never
  duplicates its logic.
- `apps/web/src/lib/services/CanvasRosterSyncService.test.ts` (new, mocked
  Canvas API + mocked db) — pagination correctness, idempotent re-sync,
  pending-user reconciliation, dropped-enrollment handling, role-change
  tracking, per-row error isolation.
- `apps/web/src/lib/services/CanvasRosterSyncService.db.test.ts` (new,
  real local Postgres, same convention as `sectionConversations.db.test.ts`
  etc.) — the same scenarios against a real DB, since the batched
  `roster.ts` writes this depends on have DB-level race/constraint
  behavior a mocked test can't exercise.
- `apps/web/src/server/routes/canvasSync.ts` (new) — `POST .../canvas/sync`,
  `GET .../canvas/status`, `GET .../canvas/courses` (course picker),
  `PUT .../canvas/link`. `requireInstructorOf`-gated.
- `apps/web/src/server/routes/canvasSync.test.ts` (new).

**Wiring**
- `apps/web/src/server/index.ts` — register the new routes, same style as
  every existing block (comment naming the issue + guard rationale).
- `apps/web/src/server/utils/audit.ts` — new `AUDIT_ACTIONS` entries
  (`CANVAS_TOKEN_SET`, `CANVAS_TOKEN_REPLACED`, `CANVAS_TOKEN_DELETED`,
  `CANVAS_TOKEN_VALIDATED`, `CANVAS_COURSE_LINKED`, `CANVAS_SYNC_STARTED`,
  `CANVAS_SYNC_COMPLETED`, `CANVAS_SYNC_FAILED`) and a
  `CREDENTIAL`/`LMS_INTEGRATION` `AUDIT_TARGET_TYPES` entry.
- `apps/web/src/shared/types.ts` (or wherever the LLM-config wire types
  live) — request/response types for the new routes, imported by both
  apps/web and apps/admin per existing convention.

**Admin UI**
- `apps/admin/src/client/views/CanvasIntegrationView.tsx` (new) — two
  sections: token management (masked display, Validate, Replace, Delete)
  and course link + sync (course picker from the token's visible courses,
  Link, Sync from Canvas button, last-sync status/counts/errors).
  Patterned directly on `TaCapabilitiesView.tsx`'s conventions: one
  `aria-live` announcer region, abortable fetches with `abortAfter`,
  server-message-first error copy, focus management on row loss.
- `apps/admin/src/client/App.tsx` — new `View` case, wired like
  `llm-configs`.
- `apps/admin/src/client/components/AdminSidebar.tsx` — new `authorOnly`
  nav entry.

**Docs**
- `docs/operations/canvas-token-setup.md` (new) — instructor-facing
  runbook: generating a token in Canvas (Account → Settings → New Access
  Token), the scopes the sync needs (`url:GET|/api/v1/courses`,
  `url:GET|/api/v1/courses/:id/enrollments`, `url:GET|/api/v1/users/self`),
  quarterly rotation, what "Validate" checks, support contact. Matches the
  path #61's own acceptance checklist names.

## Testing strategy

Covers every "Must-cover risk" both issues' bodies name:

- Token plaintext never returned to any client (assert on response JSON,
  not just on what a handler *intends* to send).
- Cross-org credential/course access refused (403), mirroring
  `llmConfigs.test.ts`'s org-scoping tests.
- Validate flow against mocked Canvas (`/users/self` 200 and 401/403).
- Pagination correctness (multi-page mocked `Link` headers, loop
  terminates on the last page).
- Idempotent re-sync (sync twice, second run reports 0 added).
- Pending-user reconciliation reuses `roster.ts` — covered by its own
  existing test suite; the sync test asserts it calls that path rather
  than re-testing user creation from scratch.
- Dropped-enrollment handling (`droppedReason: "roster_removal"`, row not
  deleted).
- Role-change tracking on an already-synced `canvasEnrollmentId`.
- Rate-limit backoff and pagination termination (`canvas-api.test.ts`,
  no network).

Run: `npm run typecheck` (root), `npm test` (root, turbo), plus
`npx vitest run --testTimeout=30000` from `apps/web/` for the
`.db.test.ts` suite against the local Docker Postgres (`DATABASE_URL`
from `.dev.vars`), matching the command the 08-12 M4 sync entry
documents.

## Manual verification

Before opening the PR: run the admin app (`npm run dev` from `apps/admin`,
`apps/web`), walk the full flow in a real browser — paste a token (a
fixture/test token is fine, validation will legitimately fail without a
live Canvas account; assert the error path renders correctly), confirm
masking, link a seeded course, trigger a sync against a mocked/stubbed
Canvas response if no live token is available, and confirm the sync
status/counts render. Screenshot the token settings and sync status
states for the PR description.

## Epic (#61) acceptance pass

Once #73/#74 are implemented and tested, re-read #61's own "End-to-end
acceptance checklist" line by line against the real code (not from
memory) before closing it, the way the M4 plan's epic-closure entries did
— check off what's genuinely satisfied, note explicitly what's deferred
(LTI, grade passback) rather than silently dropped.
