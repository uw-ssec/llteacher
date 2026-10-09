---
type: Decision
title: Course instructor edits are scoped membership changes
description: "Course Setup removal stays course-scoped; All Instructors platform revocation atomically removes every active membership and grant, but cannot orphan a course."
tags: [auth, course, roles, super-admin]
generated: { by: "codex-desktop:gpt-6", at: "2026-10-09T08:42:35Z" }
status: stable
governance: constraint
code_refs: [apps/web/src/server/repositories/courseProvisioning.ts, apps/web/src/server/routes/courseProvisioning.ts, apps/admin/src/client/views/CourseSetupView.tsx]
---

## Decision
Course Setup has separate Add instructor and Edit instructors actions. Edit marks one or more active instructor memberships for removal, supports undo, and saves a batch. The batch is atomic: a stale or nonmatching selection changes nothing. Each removed membership is soft-dropped and audited.

Course Setup removal is intentionally course-scoped. Platform instructor recognition on the user remains unchanged, as do memberships on other courses. A course may temporarily have no instructors so a super admin can correct a mistaken assignment. Re-adding an instructor restores the dropped membership through the existing add flow.

The All Instructors table exposes a separate platform-wide Remove instructor action. After explicit confirmation, it atomically soft-drops every active course membership for that user across organizations and clears both the platform instructor grant and grantor. The operation is rejected without changes when the user is the only active instructor or admin for any assigned course; the error names those courses. Successful platform and membership revocations are audited.

## Consequence
Course authority and platform access remain separate concepts with intentionally different removal scopes. UI copy must make the destructive platform-wide scope clear. Course Setup lists remain scoped to the selected course, while All Instructors lists and platform revocation operate at deployment-platform scope. A failed safeguard or database write leaves both memberships and platform access unchanged.

# Related Concepts
- [Roles live on per-course memberships instead of global Teacher/Student profiles](course-membership-roles.md): Both removal paths preserve the per-course role model; platform revocation explicitly clears all membership authority before removing platform recognition.
