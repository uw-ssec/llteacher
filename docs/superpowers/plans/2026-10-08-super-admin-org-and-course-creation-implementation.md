# Super-admin Organization and Course Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a super admin initialize the deployment's one local institution and create course shells for instructors, then let each instructor optionally connect their own Canvas account and operate any course they teach from a real course switcher.

**Architecture:** WorkOS remains authentication-only. A singleton institution row is owned by the LLTeacher deployment, course provisioning is an atomic local-database operation, and Canvas credentials belong to an instructor while each course integration records which instructor credential it uses. The admin shell owns selected-course state and passes that course to every course-scoped view.

**Tech Stack:** React 19, TypeScript, Hono, Drizzle ORM/PostgreSQL, Vitest/Testing Library, Pulumi, Floci, Docker.

**Spec:** `docs/superpowers/specs/2026-10-08-super-admin-course-provisioning-design.md`

## Global constraints

- Do not create, update, or delete anything in WorkOS. Its user and organization identifiers may only be read from an authenticated session.
- Enforce one institution per deployment in PostgreSQL, not only in UI code.
- Every new behavior is test-first. Observe the focused test fail for the intended reason before adding production code.
- Organization and course provisioning routes are super-admin-only; the regular instructor portal must never expose either mutation.
- Course creation must not give the acting super admin a course membership unless their email is explicitly entered as the instructor.
- Store Canvas secrets encrypted and never return a token in an API response, log, audit record, or browser bundle.
- A Canvas credential belongs to one instructor and may serve several of that instructor's courses. A course integration points to the credential selected during linking.
- Existing organization-scoped Canvas credentials are never guessed onto a user. They become reconnect-required legacy records.
- Canvas imports roster enrollments only. Knowledge-base content continues through the existing upload flow.
- Preserve the existing portal visual language and layout.
- Each completed task ends with focused tests and a small commit. Keep this checklist current as work proceeds.

## Review focus

The implementation must explicitly test these easy-to-miss cases:

1. Two concurrent first-run requests cannot create two institutions.
2. A provisioning failure cannot leave only a pending user, platform grant, course, or membership behind.
3. Changing the selected course cannot leave a detail view issuing requests against the previous course.
4. One instructor can use one Canvas credential for two courses, while a second instructor cannot read, spend, or silently inherit it.
5. A legacy organization Canvas token with no unambiguous owner is not used for linking or sync and produces a reconnect-required state.

---

## Task 1: Persist the authenticated WorkOS organization context without mutating WorkOS

**Files:**

- Modify: `apps/web/src/lib/session.ts`
- Modify: `apps/web/src/lib/session.test.ts`
- Modify: `apps/web/src/server/routes/auth.ts`
- Modify: `apps/web/src/server/routes/auth.test.ts`
- Modify: `apps/web/src/server/middleware/auth.test.ts`

- [x] **Step 1: Write failing session tests**

Add assertions that an optional `workosOrganizationId` survives sealing/unsealing, that older cookies without it still parse, and that malformed non-string values are rejected.

- [x] **Step 2: Run the focused tests and confirm the new assertion fails**

Run: `npm --workspace apps/web test -- --run src/lib/session.test.ts src/server/routes/auth.test.ts src/server/middleware/auth.test.ts`

- [x] **Step 3: Extend the session contract and callback**

Add `workosOrganizationId?: string` to `SessionPayload`, thread the organization id returned by AuthKit into `createSessionPayload`, and leave logout/session-epoch behavior unchanged. This is retained only as provenance for initial local setup; no WorkOS API write is added.

- [x] **Step 4: Run the focused tests**

Run: `npm --workspace apps/web test -- --run src/lib/session.test.ts src/server/routes/auth.test.ts src/server/middleware/auth.test.ts`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add apps/web/src/lib/session.ts apps/web/src/lib/session.test.ts apps/web/src/server/routes/auth.ts apps/web/src/server/routes/auth.test.ts apps/web/src/server/middleware/auth.test.ts
git commit -m "feat(auth): retain organization context in app sessions"
```

## Task 2: Add the singleton institution model and super-admin setup API

**Files:**

- Modify: `apps/web/src/db/schema/identity.ts`
- Create: `apps/web/src/db/migrations/0056_third_prism.sql`
- Modify: `apps/web/src/db/migrations/meta/_journal.json`
- Create: `apps/web/src/server/repositories/organizations.ts`
- Create: `apps/web/src/server/repositories/organizations.test.ts`
- Create: `apps/web/src/server/repositories/organizations.db.test.ts`
- Create: `apps/web/src/server/routes/organizations.ts`
- Create: `apps/web/src/server/routes/organizations.test.ts`
- Modify: `apps/web/src/server/index.ts`
- Modify: `packages/ui/src/api.ts`

- [x] **Step 1: Write failing repository and route tests**

Cover `GET /api/platform/organization` returning `organization: null`, `POST` validation for name/slug/domains, super-admin enforcement, a successful create, idempotent conflict behavior, and ordinary instructors receiving 403. In the real-DB test, race two creates and prove exactly one organization exists.

- [x] **Step 2: Run the focused tests and observe the missing implementation failure**

Run: `npm --workspace apps/web test -- --run src/server/repositories/organizations.test.ts src/server/routes/organizations.test.ts`

- [x] **Step 3: Change the schema and generate the migration**

Make `organizations.workosOrganizationId` nullable, add a database-enforced singleton deployment key/check, retain the existing unique WorkOS id when present, and add normalized uniqueness for a course shell within the institution (`organizationId`, normalized code, normalized term). Use Drizzle's migration generator, then inspect and edit the generated SQL only as needed for safe backfill and partial indexes.

Run: `npm --workspace apps/web run db:generate`

- [x] **Step 4: Implement the repository and routes**

Implement list/create with strict trimming and domain normalization. Use the authenticated WorkOS organization id only as optional provenance. Convert the singleton unique violation into HTTP 409; do not call WorkOS. Return shared response types from `@llteacher/ui/api`.

- [x] **Step 5: Run unit and real-DB tests**

Run: `npm --workspace apps/web test -- --run src/server/repositories/organizations.test.ts src/server/routes/organizations.test.ts`

Run with the repository's isolated PostgreSQL test URL: `npm --workspace apps/web test -- --run src/server/repositories/organizations.db.test.ts`

Expected: PASS, including concurrent-create coverage.

- [x] **Step 6: Commit**

```bash
git add apps/web/src/db/schema/identity.ts apps/web/src/db/migrations apps/web/src/server/repositories/organizations.ts apps/web/src/server/repositories/organizations.test.ts apps/web/src/server/repositories/organizations.db.test.ts apps/web/src/server/routes/organizations.ts apps/web/src/server/routes/organizations.test.ts apps/web/src/server/index.ts packages/ui/src/api.ts
git commit -m "feat(admin): add first-run institution setup API"
```

## Task 3: Add atomic super-admin course provisioning

**Files:**

- Create: `apps/web/src/server/repositories/courseProvisioning.ts`
- Create: `apps/web/src/server/repositories/courseProvisioning.test.ts`
- Create: `apps/web/src/server/repositories/courseProvisioning.db.test.ts`
- Create: `apps/web/src/server/routes/courseProvisioning.ts`
- Create: `apps/web/src/server/routes/courseProvisioning.test.ts`
- Modify: `apps/web/src/server/index.ts`
- Modify: `packages/ui/src/api.ts`
- Modify: `apps/web/src/server/services/AuditService.ts` (only if a new typed action is required)

- [x] **Step 1: Write failing contract tests**

Test trimmed/lowercased email input, valid title/code/term, missing-organization conflict, unauthorized callers, existing and pending instructor reuse, no acting-admin membership, duplicate-shell conflict, and a response containing the new course and assigned instructor.

- [x] **Step 2: Write the failing real-DB rollback test**

Force the final membership insert to fail and assert that no pending user, platform instructor grant, or course survived. Also prove a happy path atomically creates/reuses the user, grants platform instructor access, creates the course, and inserts the instructor membership.

- [x] **Step 3: Run the tests and confirm failure for the missing repository/route**

Run: `npm --workspace apps/web test -- --run src/server/repositories/courseProvisioning.test.ts src/server/routes/courseProvisioning.test.ts`

- [x] **Step 4: Implement one atomic provisioning operation**

Generate ids in the application, blind-index/encrypt the instructor email using the existing identity utilities, and build all writes against the transaction handle passed to `runAtomically`. Use conflict-safe inserts/upserts where the repository already permits reuse, but surface a duplicate course shell as 409. Keep the audit event outside the transaction, matching the repository's existing best-effort audit policy, and never include PII beyond the established audit convention.

- [x] **Step 5: Run focused and real-DB tests**

Run: `npm --workspace apps/web test -- --run src/server/repositories/courseProvisioning.test.ts src/server/routes/courseProvisioning.test.ts`

Run with isolated PostgreSQL: `npm --workspace apps/web test -- --run src/server/repositories/courseProvisioning.db.test.ts`

Expected: PASS, including the forced rollback.

- [x] **Step 6: Commit**

```bash
git add apps/web/src/server/repositories/courseProvisioning.ts apps/web/src/server/repositories/courseProvisioning.test.ts apps/web/src/server/repositories/courseProvisioning.db.test.ts apps/web/src/server/routes/courseProvisioning.ts apps/web/src/server/routes/courseProvisioning.test.ts apps/web/src/server/index.ts packages/ui/src/api.ts apps/web/src/server/services/AuditService.ts
git commit -m "feat(admin): provision instructor course shells atomically"
```

## Task 4: Add first-run institution setup and Course Setup to the admin portal

**Files:**

- Modify: `apps/admin/src/client/lib/api-client.ts`
- Modify: `apps/admin/src/client/lib/api-client.test.ts`
- Create: `apps/admin/src/client/views/OrganizationSetupView.tsx`
- Create: `apps/admin/src/client/views/OrganizationSetupView.test.tsx`
- Create: `apps/admin/src/client/views/CourseSetupView.tsx`
- Create: `apps/admin/src/client/views/CourseSetupView.test.tsx`
- Modify: `apps/admin/src/client/components/AdminSidebar.tsx`
- Modify: `apps/admin/src/client/components/AdminSidebar.test.tsx`
- Modify: `apps/admin/src/client/App.tsx`
- Modify: `apps/admin/src/client/App.test.tsx`

- [ ] **Step 1: Write failing UI and request tests**

Cover: a super admin with no institution sees a blocking first-run form; instructors never see it; organization fields validate and submit; after success the regular portal appears; Course Setup appears only for super admins; successful provisioning reports the instructor and course without pretending Canvas is linked; and an API error preserves entered values.

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `npm --workspace apps/admin test -- --run src/client/lib/api-client.test.ts src/client/views/OrganizationSetupView.test.tsx src/client/views/CourseSetupView.test.tsx src/client/components/AdminSidebar.test.tsx src/client/App.test.tsx`

- [ ] **Step 3: Implement the two forms and app gating**

Add typed API-client groups for the singleton organization and course provisioning endpoints. Keep the existing portal design. The organization screen is an explicit first-run gate only for a super admin when no local institution exists; the course form remains a super-admin sidebar tab afterward. Do not add Canvas inputs to Course Setup.

- [ ] **Step 4: Run the focused tests**

Run the command from Step 2.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/client/lib/api-client.ts apps/admin/src/client/lib/api-client.test.ts apps/admin/src/client/views/OrganizationSetupView.tsx apps/admin/src/client/views/OrganizationSetupView.test.tsx apps/admin/src/client/views/CourseSetupView.tsx apps/admin/src/client/views/CourseSetupView.test.tsx apps/admin/src/client/components/AdminSidebar.tsx apps/admin/src/client/components/AdminSidebar.test.tsx apps/admin/src/client/App.tsx apps/admin/src/client/App.test.tsx
git commit -m "feat(admin): add organization and course setup screens"
```

## Task 5: Add a real selected-course context and switcher

**Files:**

- Modify: `apps/web/src/lib/services/ProfileService.ts`
- Modify: `apps/web/src/lib/services/ProfileService.test.ts`
- Modify: `apps/web/src/server/routes/profile.test.ts`
- Modify: `packages/ui/src/api.ts`
- Modify: `packages/ui/src/components/TopNav.tsx`
- Modify: `packages/ui/src/components/TopNav.test.tsx`
- Modify: `apps/admin/src/client/components/AuthProvider.tsx`
- Modify: `apps/admin/src/client/components/AuthProvider.test.tsx`
- Modify: `apps/admin/src/client/App.tsx`
- Modify: `apps/admin/src/client/App.test.tsx`

- [ ] **Step 1: Write failing API and UI tests**

Require each profile course to expose code and term. Test zero, one, and multiple courses; switching updates the displayed breadcrumb; selection persists by user in localStorage; a stale stored id falls back deterministically; and switching from a nested/detail view returns to that course's safe default rather than leaking old-course ids.

- [ ] **Step 2: Run focused tests and confirm the missing metadata/switcher failures**

Run: `npm --workspace apps/web test -- --run src/lib/services/ProfileService.test.ts src/server/routes/profile.test.ts && npm --workspace packages/ui test -- --run src/components/TopNav.test.tsx && npm --workspace apps/admin test -- --run src/client/components/AuthProvider.test.tsx src/client/App.test.tsx`

- [ ] **Step 3: Implement selected-course ownership in the app shell**

Extend the profile response, render a compact TopNav selector only when multiple courses exist, key persisted selection by authenticated user id, and replace `courses[0]`/hard-coded `STATS 311` and term values. On change, reset course-scoped view state and let every resource refetch through the selected id.

- [ ] **Step 4: Run focused tests**

Run the command from Step 2.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/services/ProfileService.ts apps/web/src/lib/services/ProfileService.test.ts apps/web/src/server/routes/profile.test.ts packages/ui/src/api.ts packages/ui/src/components/TopNav.tsx packages/ui/src/components/TopNav.test.tsx apps/admin/src/client/components/AuthProvider.tsx apps/admin/src/client/components/AuthProvider.test.tsx apps/admin/src/client/App.tsx apps/admin/src/client/App.test.tsx
git commit -m "feat(admin): add instructor course switching"
```

## Task 6: Migrate Canvas credentials from institution ownership to instructor ownership

**Files:**

- Modify: `apps/web/src/db/schema/identity.ts`
- Create: `apps/web/src/db/migrations/0057_instructor_canvas_credentials.sql`
- Modify: `apps/web/src/server/repositories/organizationCredentials.ts`
- Modify: `apps/web/src/server/repositories/organizationCredentials.test.ts`
- Create: `apps/web/src/server/repositories/organizationCredentials.db.test.ts`
- Modify: `apps/web/src/server/routes/canvasCredentials.ts`
- Modify: `apps/web/src/server/routes/canvasCredentials.test.ts`
- Modify: `apps/web/src/server/routes/canvasSync.ts`
- Modify: `apps/web/src/server/routes/canvasSync.test.ts`
- Modify: `packages/ui/src/api.ts`

- [ ] **Step 1: Write failing ownership tests**

Cover one instructor saving one credential and using it for two linked courses, another instructor seeing only an unconfigured state, refusal to link or sync with another instructor's credential, course sync loading the exact credential id stored on `lms_integrations`, co-instructor rebind using their own credential, and token responses remaining secret-free.

- [ ] **Step 2: Write failing legacy-migration tests**

Create an old organization-owned Canvas credential with `owner_user_id IS NULL`; prove it is reported as reconnect-required and cannot be spent. Prove the migration does not infer ownership from course memberships or current integrations.

- [ ] **Step 3: Run focused tests and observe ownership failures**

Run: `npm --workspace apps/web test -- --run src/server/repositories/organizationCredentials.test.ts src/server/routes/canvasCredentials.test.ts src/server/routes/canvasSync.test.ts`

- [ ] **Step 4: Implement schema and repository ownership**

Add nullable `ownerUserId` for safe legacy representation, remove the organization-wide uniqueness that blocks multiple instructors, add partial unique indexes for instructor-owned Canvas credentials and legacy rows, and update helpers to require `(organization scope, authenticated user id)` for normal read/write/delete. Add an explicit lookup-by-id used only after verifying the integration's credential owner matches the caller.

- [ ] **Step 5: Update routes and linking/sync semantics**

Expose the account credential endpoints as instructor-owned resources, bind a selected course integration to the current instructor's credential during Canvas linking, and make sync use that stored id while enforcing its owner. Preserve course authorization and base-URL validation. Do not add Canvas material import endpoints.

- [ ] **Step 6: Run unit and real-DB tests**

Run the command from Step 3, then run: `npm --workspace apps/web test -- --run src/server/repositories/organizationCredentials.db.test.ts src/server/routes/canvasProvisioning.integration.test.ts`

Expected: PASS, including legacy reconnect behavior and cross-instructor denial.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/db/schema/identity.ts apps/web/src/db/migrations/0057_instructor_canvas_credentials.sql apps/web/src/db/migrations/meta apps/web/src/server/repositories/organizationCredentials.ts apps/web/src/server/repositories/organizationCredentials.test.ts apps/web/src/server/repositories/organizationCredentials.db.test.ts apps/web/src/server/routes/canvasCredentials.ts apps/web/src/server/routes/canvasCredentials.test.ts apps/web/src/server/routes/canvasSync.ts apps/web/src/server/routes/canvasSync.test.ts packages/ui/src/api.ts
git commit -m "feat(canvas): scope credentials to instructors"
```

## Task 7: Split Canvas UI into account setup and course linking

**Files:**

- Modify: `apps/admin/src/client/lib/api-client.ts`
- Modify: `apps/admin/src/client/lib/api-client.test.ts`
- Modify: `apps/admin/src/client/views/CanvasIntegrationView.tsx`
- Modify: `apps/admin/src/client/views/CanvasIntegrationView.test.tsx`
- Modify: `apps/admin/src/client/App.tsx`
- Modify: `apps/admin/src/client/App.test.tsx`

- [ ] **Step 1: Write failing Canvas UI tests**

Test separate “My Canvas account” and “This course’s Canvas connection” sections; token setup once across multiple courses; per-course Canvas course selection; optional/unlinked course state; roster-only language; legacy reconnect-required state; switcher-driven course changes; and no token value rendered after save.

- [ ] **Step 2: Run tests and observe the expected failures**

Run: `npm --workspace apps/admin test -- --run src/client/lib/api-client.test.ts src/client/views/CanvasIntegrationView.test.tsx src/client/App.test.tsx`

- [ ] **Step 3: Implement the split account/course flow**

Use instructor-scoped credential endpoints for save/validate/delete and course-scoped endpoints for list/link/sync. Make linking optional, clearly state that only the roster imports, and direct materials to the existing Knowledge tab. When the selected course changes, reload only its connection while retaining the instructor account summary.

- [ ] **Step 4: Run focused tests**

Run the command from Step 2.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/client/lib/api-client.ts apps/admin/src/client/lib/api-client.test.ts apps/admin/src/client/views/CanvasIntegrationView.tsx apps/admin/src/client/views/CanvasIntegrationView.test.tsx apps/admin/src/client/App.tsx apps/admin/src/client/App.test.tsx
git commit -m "feat(admin): separate Canvas account and course linking"
```

## Task 8: Update operator documentation and decision record

**Files:**

- Modify: `docs/superpowers/specs/2026-10-08-super-admin-course-provisioning-design.md`
- Create: `docs/super-admin-onboarding.md`
- Modify: `infra/README.md`

- [ ] **Step 1: Record implementation-time decisions**

Append a dated implementation-decisions section to the approved design for any concrete choices discovered while coding, especially migration handling, conflict semantics, and the exact course-selection persistence policy. Do not rewrite the approved product decisions.

- [ ] **Step 2: Write the super-admin runbook**

Document the exact flow: sign in; initialize the one institution; grant/provision the instructor through Course Setup; instructor signs in; selects their course; optionally configures their Canvas account; links the Canvas course; imports the roster; adds TAs; uploads course materials through Knowledge. Explicitly state that deployments for other institutions enter their own local institution and make no WorkOS change.

- [ ] **Step 3: Document clean Floci acceptance deployments**

Add a short procedure for using a new Floci container/state path and a new Pulumi stack so acceptance testing never reuses or deletes an existing RDS volume/database.

- [ ] **Step 4: Check links and formatting, then commit**

Run: `git diff --check`

```bash
git add docs/superpowers/specs/2026-10-08-super-admin-course-provisioning-design.md docs/super-admin-onboarding.md infra/README.md
git commit -m "docs: add super-admin onboarding runbook"
```

## Task 9: Full verification and clean Floci deployment

**Files:**

- Modify only if verification reveals an in-scope defect; return to the owning task's red-green cycle before fixing it.

- [ ] **Step 1: Run static and repository checks**

Run: `npm run typecheck && npm test && git diff --check && git status --short`

Expected: all checks pass and the worktree contains no uncommitted product changes.

- [ ] **Step 2: Review the implementation against the approved spec and review-focus cases**

Inspect the branch diff from `862bb38`. Confirm all five Review Focus cases have direct automated coverage and that no WorkOS mutation or Canvas content import was introduced.

- [ ] **Step 3: Create an isolated, empty Floci environment**

Start a second Floci container with a unique name, host ports, Docker volume or empty state directory, and network identity. Create a new Pulumi stack named for this feature. Do not point at, stop, prune, reset, mount, or reuse the existing `llteacher-floci` container, `.floci/data`, Pulumi `local` stack, RDS Docker volume, or database.

- [ ] **Step 4: Deploy a new application and new database**

Build the branch image, deploy the infrastructure to the isolated Floci endpoint, run every migration against the newly created database, and bring up the web/admin services using the existing development secrets without changing WorkOS configuration.

- [ ] **Step 5: Prove the database starts empty**

Before using the UI, query counts for `organizations`, `courses`, and `course_memberships`; capture evidence that each is zero. Do not seed an organization or course.

- [ ] **Step 6: Smoke-test the complete first-run flow**

Open the deployed admin URL and verify: super-admin sign-in reaches institution setup; create the UW institution; Course Setup becomes available; create a course for an instructor; sign in as that instructor; verify the course switcher/context; optionally connect their Canvas account and link the course; import roster only; add a TA; upload materials through Knowledge.

If human WorkOS credentials or a real Canvas token are required, stop at the login/token boundary and hand the isolated deployment URL plus exact remaining clicks to the user. The automated/API portions, clean-database proof, health checks, and deployment diagnostics must already be complete.

- [ ] **Step 7: Commit any deployment documentation or fixes, then report**

Include the branch name, commit list, verification evidence, isolated Floci container/stack/database identifiers, deployment URL, and any user-only acceptance step. Do not claim the manual flow passed unless it was actually completed.
