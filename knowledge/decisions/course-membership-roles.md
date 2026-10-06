---
type: Decision
title: Roles live on per-course memberships instead of global Teacher/Student profiles
description: "Django's Teacher/Student one-to-one profiles were dropped; role is a course_role enum (instructor, ta, student, observer, admin) on course_memberships, with instructor-granted per-course TA capabilities."
tags: [data-model, auth, roles, tenancy]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:32:35Z" }
status: stable
governance: constraint
code_refs: [apps/web/src/db/schema/identity.ts, apps/web/src/server/middleware/roles.ts, apps/web/src/server/utils/guards.ts, apps/web/src/lib/instructor-authz.ts, apps/web/src/server/repositories/roster.ts]
sources:
  - resource: docs/architecture/multi-tenant-data-model.md
  - resource: docs/superpowers/plans/2026-07-31-m1-auth-workos.md
  - resource: "PR #209"
  - resource: commit 1c267fd
  - resource: commit f7333ab
---

## Spec proposed
Data-model decision 2 (rev 3) was: "drop `Teacher` / `Student`. Role lives on `CourseMembership` with an enum." The Django model had global profiles, with homeworks owned by a `Teacher` FK and no co-instructors or TAs. The port plan asked whether to keep two tables or collapse them into `users.role`. Neither was chosen. Role became per-course.

## Implemented
- `identity.ts` defines `courseRoleEnum = ['instructor','ta','student','observer','admin']`.
- `course_memberships` carries `droppedAt`/`droppedReason` (enum including `roster_removal`) and Canvas projection columns (`canvasEnrollmentId`, `canvasRole`).
- `rolesMiddleware` loads a user's active memberships once per request (via `repositories/users.ts`; dropped rows are filtered per #139). It attaches `AuthContext` predicates: `hasRole`, `isMemberOf`, `isInstructorOf`, and `isGraderOf`.
- `server/utils/guards.ts` provides `requireCourseMember`, `requireInstructorOf`, and `requireRole`. They resolve `courseId` from a **named URL param**, which is why course-scoped routes nest under `/api/courses/:courseId/...` (M3 decision 2).
- #172 (PR #209) added per-membership TA capabilities granted by an instructor. A check constraint `course_memberships_capabilities_require_ta` ensures they only apply to TAs. This splits grading authority (`isGraderOf`: instructor, admin, or ta) from authoring.
- Commit `f7333ab` resolves each course's membership once, so the predicates agree by construction.

## Why
Co-instructors and TAs, multi-course students, and Canvas enrollments all need roles scoped per course. A global flag cannot express "instructor in A, student in B".

## Rejected alternatives
- Global profiles.
- A single `users.role`.
- Storing roles in WorkOS metadata.

## Consequences
- Any new guarded route must take `:courseId` in its path, or use an explicit lookup and ownership check.
- A user with no memberships is effectively unprivileged, except super admins. Staff-only accounts land on a teaching workspace (commit `5cdf28d`).

# Related Concepts
- [Authentication and authorization](../architecture/auth-and-authorization.md): Roles drive authorization checks
- [Authorization model and known gaps: course-scoped roles, super admins, no course creation](../facts/authority-and-provisioning-gaps.md): Known gaps in authority and provisioning
- [Stakeholder requirement (unresolved): aggregate vs individual student data for instructors](../requirements/stakeholder-instructor-visibility-of-student-data.md): What instructors may see is still unresolved
