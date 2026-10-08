---
type: Fact
title: "Authorization model and known gaps: course-scoped roles, super admins, no course creation"
description: "All authority is course-scoped (course_memberships roles; TA is a grader with per-course grants); org-level config is editable by any course instructor (#367); there is no course-creation path (#464, M13)."
tags: [authz, roles, multi-tenancy, admin]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-08T20:08:07Z" }
status: stable
governance: constraint
code_refs: [apps/web/src/server/middleware/roles.ts, apps/web/src/lib/services/SuperAdminService.ts, apps/web/src/db/schema/identity.ts, packages/ui]
sources:
  - resource: "PR #110"
  - resource: "PR #209"
  - resource: "PR #363"
  - resource: "issue #367"
  - resource: "PR #464"
  - resource: "issue #316"
  - resource: "issue #183"
  - resource: "issue #171"
  - resource: "issue #246"
---

## Model

- `course_memberships.role` has the values `instructor | ta | student | observer | admin`. **Every authority is a course key.** There is no org-level membership table.
- `rolesMiddleware` resolves each course membership **once per request**, so `isMemberOf`, `isInstructorOf`, `isGraderOf`, `canViewSolutionsIn` and `canViewDraftsIn` agree by construction (PR #209). Dropped memberships (`dropped_at`) are filtered from every access decision (#139).
- **TA = grader, not author** (PR #209). `GRADER_ROLES` covers instructor, admin and ta. `AUTHOR_ROLES` covers instructor and admin. Both are defined once and pinned against the Postgres enum by `courseRoleParity.test.ts`. The per-course flags `can_view_solutions` and `can_view_drafts` are granted only by instructors. Section transcripts are readable at grader tier (#246).
- Guards: `requireRole`, `requireCourseMember`, `requireInstructorOf`, `requireGraderOf`, and `requireSuperAdmin` (PR #464).

## Super admins and provisioning (PR #464, closing #316)

- Before PR #464, the only way to create a course membership was a hand-written SQL `INSERT` against production.
- `SuperAdminService` holds a hardcoded allowlist checked by blind-index equality. It grants elevated access across every course-scoped guard (`isSuperAdmin`) without changing `guards.ts`.
- `POST /api/courses/:courseId/members` (super admin only) adds people to existing courses through the existing `upsertCourseMember` pipeline.
- `POST /api/platform/instructors` creates a courseless **platform instructor** grant. It only gets the person past the console gate and grants no course access.
- **No course-creation path exists in production code.** Only `scripts/seed.ts` creates courses. Course and org management are M13 (#68–#72), with TA assignment in #171.

## Known gaps (open)

- **#367:** `llm_configs` is per org, but `requireInstructorOf` on any course in the org can edit it, including the org default. The plan is an **Org Admin** role. PR #363 documents this widening as a tracked gap, not a design choice.
- #183: whether TA grants survive deprovisioning.
- #237: TA section conversations are recorded as student work.
- #377: transcript paging counts rows a draft-restricted TA cannot see.

# Related Concepts
- [Org Admin owns the shared LLM config pool; course instructors own course-scoped configs](../decisions/org-admin-role-and-course-scoped-configs.md): #367 closed the org-level LLM config gap with an Org Admin role
