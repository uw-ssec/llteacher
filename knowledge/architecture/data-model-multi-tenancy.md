---
type: Architecture
title: Data model and shared-schema multi-tenancy
description: "One Postgres schema for all tenants: denormalized organization_id/course_id on leaf tables plus branded OrgScope/CourseScope types required by every repository function; routes must not query Drizzle directly."
tags: [architecture, database, tenancy, drizzle]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:30:53Z" }
status: stable
governance: constraint
code_refs: ["apps/web/src/db/schema.ts", "apps/web/src/db/schema", "apps/web/src/server/repositories/scope.ts", "apps/web/src/server/repositories/errors.ts", "apps/web/src/server/repositories", "apps/web/ARCHITECTURE.md"]
sources:
  - resource: "apps/web/ARCHITECTURE.md"
  - resource: "apps/web/src/db/schema/identity.ts"
  - resource: "docs/architecture/multi-tenant-data-model.md"
---

**Schema layout.** `apps/web/src/db/schema.ts` is a barrel (drizzle-kit reads it) re-exporting `schema/pings.ts`, `schema/identity.ts` (organizations, users, courses, course_memberships, organization_credentials, lms_integrations, lti_launches, workos_webhook_events), `schema/content.ts` (llm_configs, prompt_templates, homeworks, sections, hint_budgets, section_solutions, course_materials, material_chunks, knowledge_documents/links, collections, agent_definitions) and `schema/runtime.ts` (conversations, messages, submissions, grades, citations, llm_call_logs, response_feedback, hint_events, section_answers, chat_rate_limit_windows, student_profiles, audit_events). New tables go in a module and must be re-exported from the barrel.

**Tenancy enforcement (two mechanisms):**
1. Every runtime leaf table carries a denormalized `organization_id` or `course_id` so the tenancy filter is on the queried table itself, indexed.
2. `OrgScope`/`CourseScope` in `server/repositories/scope.ts` are branded strings. Every repository function takes one; passing a raw string is a compile error. Mint them only from an `AuthContext` membership or a row just read back, never from request input.

**Rule:** files in `server/routes/*.ts` must not import tables from `db/schema` or drizzle helpers (`eq`, `and`). Shape: `makeDb(c.env.DATABASE_URL)` -> resolve scope -> call repositories -> shape response. This is enforced by review only, no lint rule. Jobs (`server/jobs/*`) follow the same rule; the only unscoped read allowed is `listAllOrgScopes`.

**Ownership is separate from scope.** `CourseScope` proves the row is in the course, not that the caller owns it. Conversation-mutating repository functions (`appendMessage`, `softDeleteConversation`, `updateConversationTitle`) do not check owner; call `getOwnedConversationOrNull` first (#301, #134 still open).

**Errors:** a scope mismatch throws `TenancyMismatchError`, mapped to 404 centrally (never leak existence). `createSubmission` deliberately uses 403 instead.

**Other invariants:** `messages.seq` (global bigserial) is the ordering key, not `created_at`. Submissions are one per (student, section), enforced by a composite FK to conversations plus UNIQUE; restart via `restartSectionConversation`; `grades.submission_id` is ON DELETE RESTRICT. The course role enum (`instructor, ta, student, observer, admin`) is hand-mirrored in `packages/ui/src/auth/courseRole.ts`, guarded by `courseRoleParity.test.ts`.
