---
type: Requirement
title: "Data access is tenant-scoped: repositories take a branded scope, and routes check ownership"
description: Routes never query Drizzle directly; every repository function takes OrgScope/CourseScope minted from AuthContext; conversation-mutating routes must verify row ownership first; course id is never taken from a request body for tools.
tags: [tenancy, security, repositories, ferpa]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:25:30Z" }
status: stable
governance: constraint
code_refs: ["apps/web/src/server/repositories/scope.ts", "apps/web/src/server/repositories/conversations.ts", "apps/web/src/server/utils/guards.ts", "apps/web/src/server/middleware/roles.ts", "apps/web/ARCHITECTURE.md"]
sources:
  - resource: "apps/web/ARCHITECTURE.md"
  - resource: "docs/superpowers/plans/2026-08-03-m2-runtime-persistence.md"
  - resource: "docs/superpowers/plans/2026-09-09-knowledge-management.md"
  - resource: "docs/superpowers/specs/2026-09-15-okf-bundle-knowledge-base-design.md"
---

## The requirement
Any code change must keep these invariants. They are the only thing between tenants in a shared schema.

1. **Routes and middleware do not import Drizzle query helpers or table objects.** They call repository functions (M2 global constraint; repo-wide grep at M2 close). `rolesMiddleware` uses `repositories/users.ts`.
2. **Every repository function takes a branded `OrgScope` or `CourseScope`** as its second parameter. `homeworks`, `sections`, `conversations`, `messages`, and `courseMaterials` use `CourseScope`. `submissions`, `grades`, `citations`, `llm_call_logs`, `student_profiles`, `audit_events`, and `llmConfigs` use `OrgScope`.
3. **Route code mints scopes only through `courseScopeFromAuthContext`**, which fails closed for non-members and dropped memberships. `unsafeCourseScope` / `unsafeOrgScope` are for tests, or for values just read back from the database.
4. **Write functions check the parent chain** before writing denormalized `organization_id` or `course_id` (#132).
5. **Row ownership is a route-layer duty.** `softDeleteConversation`, `appendMessage`, and `updateConversationTitle` do not check the owner. A new conversation-mutating route must call `getOwnedConversationOrNull` first. The repository-level `requesterId` parameter (#134) is still not built.
6. **Course-scoped routes nest under `/api/courses/:courseId/...`** and use `requireInstructorOf` / `requireCourseMember`.
7. **Knowledge tools derive the course from the conversation** (`experimental_context`) and never accept a course or bundle argument. The bundle path is never an input.
8. **Repositories never `SELECT *`.** They project columns explicitly so an additive column deployed before its migration degrades instead of crashing (knowledge plan constraint).

## Test hooks
- Cross-org isolation tests exist in the repositories' `.db.test.ts` suites.
- The knowledge spec requires a cross-course `showKnowledge` test (same concept id in two courses).

## Known limits
- The S3 task role can read every course prefix. Per-course isolation is application-only.
- Organization deletion cascades away grades, LLM logs, and audit events with no gate (see `requirements/ferpa-data-protection-open-items`).
