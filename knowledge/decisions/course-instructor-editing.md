---
type: Decision
title: Course instructor edits are scoped membership changes
description: "Super-admin removal soft-drops selected instructor memberships atomically, leaving platform grants and other courses intact; a course may temporarily have zero instructors."
tags: [auth, course, roles, super-admin]
generated: { by: "codex-desktop:gpt-6", at: "2026-10-09T07:50:26Z" }
status: stable
governance: constraint
code_refs: [apps/web/src/server/repositories/courseProvisioning.ts, apps/web/src/server/routes/courseProvisioning.ts, apps/admin/src/client/views/CourseSetupView.tsx]
---

## Decision
Course Setup has separate Add instructor and Edit instructors actions. Edit marks one or more active instructor memberships for removal, supports undo, and saves a batch. The batch is atomic: a stale or nonmatching selection changes nothing. Each removed membership is soft-dropped and audited.

Platform instructor recognition on the user remains unchanged, as do memberships on other courses. A course may temporarily have no instructors so a super admin can correct a mistaken assignment. Re-adding an instructor restores the dropped membership through the existing add flow.

## Consequence
Instructor portal access and course authority remain separate. UI lists must show active instructors and assigned course codes from the current deployment organization only.

# Related Concepts
- [Roles live on per-course memberships instead of global Teacher/Student profiles](course-membership-roles.md): Course removal preserves the per-course role model and keeps platform recognition separate from membership authority.
