# Add Course Instructor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a super admin add another instructor to an existing course without removing any current instructor.

**Architecture:** Extend the existing super-admin course provisioning boundary with one atomic repository operation and one protected HTTP endpoint. Add a per-course inline form to the existing Course Setup table; the client submits the email, reports the outcome, and refreshes the authoritative course list.

**Tech Stack:** TypeScript, Hono, Drizzle/PostgreSQL, React, Vitest, Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-08-super-admin-course-provisioning-design.md`, extended by the approved bounded design in this session.

## Global Constraints

- Add-only: retain every existing instructor membership.
- Super-admin authorization is required at the registered route and rechecked by the handler convention.
- Normalize and validate the email against the deployment organization's allowed domains.
- Create or reuse a pending user, grant platform-instructor access if absent, and create or restore the instructor membership atomically.
- Do not call WorkOS; identity is claimed by normalized email on first login.
- Repeating the same assignment is safe and must not create duplicate memberships or misleading audit events.
- No schema migration unless tests prove the current membership constraints cannot express the behavior.

## Review Focus

- An already-assigned instructor receives an idempotent success response and no duplicate membership.
- A removed membership is restored rather than duplicated.
- A course outside the deployment organization or an unknown course is not mutated.
- A disallowed or malformed email creates neither a user, grant, nor membership.
- A failed membership write leaves no partial user/grant mutation committed.

---

### Task 1: Atomic add-instructor API

**Files:**
- Modify: `packages/ui/src/api/types.ts`
- Modify: `apps/web/src/server/repositories/courseProvisioning.ts`
- Modify: `apps/web/src/server/repositories/courseProvisioning.db.test.ts`
- Modify: `apps/web/src/server/routes/courseProvisioning.ts`
- Modify: `apps/web/src/server/routes/courseProvisioning.test.ts`
- Modify: `apps/web/src/server/index.ts`

**Interfaces:**
- Produces: `AddCourseInstructorBody`, `AddCourseInstructorResponse`, `addInstructorToCourse(db, cipher, actorUserId, courseId, email)`, and `addCourseInstructorHandler`.
- Response includes the assigned `{ userId, email }` and whether the membership was newly added/restored versus already active.

- [ ] **Step 1: Write failing repository tests**

Add real-database cases for adding a second instructor while retaining the first, idempotent repeat assignment, restoring a removed membership, rejecting an unknown/cross-organization course, rejecting a disallowed email without partial writes, and transaction rollback on membership failure.

- [ ] **Step 2: Run repository tests and verify RED**

Run: `npm exec vitest run src/server/repositories/courseProvisioning.db.test.ts --workspace=llteacher-web`

Expected: FAIL because `addInstructorToCourse` does not exist.

- [ ] **Step 3: Implement the atomic repository operation**

Refactor the existing transaction-local instructor identity/grant logic only as needed so course creation and `addInstructorToCourse` share the same normalization, allowlist, pending-user, and grant semantics. Lock by normalized email, scope the course to the deployment organization, and insert or restore one `instructor` membership without changing other memberships.

- [ ] **Step 4: Run repository tests and verify GREEN**

Run the Task 1 repository command; expect all enabled cases to pass (database-backed cases may remain explicitly skipped when `DATABASE_URL` is absent).

- [ ] **Step 5: Write failing route tests**

Cover super-admin success, normalized request input, invalid body/email, missing course, disallowed domain, idempotent response, and audit behavior that emits grant/membership events only when those changes occur.

- [ ] **Step 6: Run route tests and verify RED**

Run: `npm exec vitest run src/server/routes/courseProvisioning.test.ts --workspace=llteacher-web`

Expected: FAIL because the handler and route contract do not exist.

- [ ] **Step 7: Implement types, handler, route registration, and audit calls**

Register `POST /api/platform/courses/:courseId/instructors` behind `requireSuperAdmin()`. Return `201` for a newly added/restored membership, `200` for an already-active assignment, `400` for invalid/disallowed email, and `404` for an unknown course.

- [ ] **Step 8: Run Task 1 tests and typecheck**

Run:
- `npm exec vitest run src/server/routes/courseProvisioning.test.ts src/server/repositories/courseProvisioning.db.test.ts --workspace=llteacher-web`
- `npm run typecheck --workspace=llteacher-web`

Expected: PASS.

- [ ] **Step 9: Commit Task 1**

Commit message: `feat(admin): add instructors to existing courses`

### Task 2: Course Setup add-instructor UI

**Files:**
- Modify: `apps/admin/src/client/lib/api-client.ts`
- Modify: `apps/admin/src/client/lib/api-client.test.ts`
- Modify: `apps/admin/src/client/views/CourseSetupView.tsx`
- Modify: `apps/admin/src/client/views/CourseSetupView.test.tsx`
- Modify: `docs/super-admin-onboarding.md`

**Interfaces:**
- Consumes: `AddCourseInstructorBody` and `AddCourseInstructorResponse` from Task 1.
- Produces: `apiClient.platformCourses.addInstructor(courseId, body, opts)` and an inline per-course add-instructor form.

- [ ] **Step 1: Write failing API-client and view tests**

Assert the client posts to the encoded course URL. In the view, assert each row can open an email form, submit a second instructor, preserve displayed existing instructors, reload the list, show an accessible success message, retain the entered email on failure, and prevent duplicate submits while busy.

- [ ] **Step 2: Run UI tests and verify RED**

Run: `npm exec vitest run lib/api-client.test.ts views/CourseSetupView.test.tsx --workspace=llteacher-admin`

Expected: FAIL because `addInstructor` and the row action do not exist.

- [ ] **Step 3: Implement the client method and inline UI**

Keep mutation state scoped by course ID. Use the existing form/button/alert styles, label every email field with its course, and refetch the authoritative list after success rather than manually patching membership data.

- [ ] **Step 4: Document the correction workflow**

Add a short super-admin onboarding note explaining that Course Setup can add another instructor to an existing course and does not remove current instructors.

- [ ] **Step 5: Run UI tests and typecheck**

Run:
- `npm exec vitest run lib/api-client.test.ts views/CourseSetupView.test.tsx --workspace=llteacher-admin`
- `npm run typecheck --workspace=llteacher-admin`

Expected: PASS.

- [ ] **Step 6: Run combined verification**

Run:
- `npm run typecheck`
- `CI=true npm test`
- `git diff --check`

Expected: all tasks pass; any environment-gated database suites remain explicitly skipped rather than silently mocked.

- [ ] **Step 7: Commit Task 2**

Commit message: `feat(admin): manage course instructors from setup`

