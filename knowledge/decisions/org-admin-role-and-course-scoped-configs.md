---
type: Decision
title: Org Admin owns the shared LLM config pool; course instructors own course-scoped configs
description: "#367: organization_memberships holds an Org Admin role that owns the org's shared LLM config pool and default; llm_configs.scope_course_id lets instructors own configs for their course only; no backfill; super admins bootstrap."
tags: [authorization, org-admin, llm-config, tenancy, 367]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-08T20:08:07Z" }
status: stable
governance: constraint
code_refs: ["apps/web/src/server/routes/llmConfigs.ts", "apps/web/src/server/routes/organizationAdmins.ts", "apps/web/src/server/repositories/llmConfigs.ts", "apps/web/src/server/middleware/roles.ts", "apps/web/src/db/schema/identity.ts", "apps/web/src/db/schema/content.ts", "apps/admin/src/client/views/LLMConfigsDataLoader.tsx", "apps/admin/src/client/views/LLMConfigFormView.tsx", "apps/admin/src/client/views/LLMConfigsView.tsx"]
sources:
  - resource: "issue #367"
  - resource: "migration 0056_org_admin_role_and_course_scoped_llm_configs"
---

## Decision (2026-10-08, #367)

Before: every `/api/courses/:courseId/llm-configs*` route checked instructor-of-COURSE and then wrote the course's ORGANIZATION pool, so an instructor of one course could edit configs other courses used and move the org default.

1. **Where the role lives:** a new `organization_memberships` table (user x organization x `organization_role` = `admin`). Rejected: reusing `course_memberships.role = 'admin'`, which would put an org-wide grant on a course-keyed row.
2. **What instructors keep:** `llm_configs.scope_course_id` (mirrors `prompt_templates`). Null = the shared pool (Org Admin-owned); set = that course's own config, which its instructors create, edit, deactivate and clone into. Instructors see and test the pool and their own configs, never another course's (another course's config answers 404, even to an Org Admin). Rejected: read-only pool plus a per-course override only, which would leave instructors unable to author at all without an admin.
3. **Day one:** no backfill (promoting every instructor would preserve the widening). Super admins hold `isOrgAdminOf` everywhere and bootstrap via `POST /api/organizations/:organizationId/admins` (by email; pending user if needed); Org Admins grant and revoke within their org. Audited as `membership.org_admin_granted/revoked`.
4. **The org default:** only a pool config can be default (`llm_configs_default_is_org_pool_chk`) and only an Org Admin can move it; `ensurePlatformDefaultLLMConfig` still auto-provisions it as a system action.

## Invariants a change must keep

- Writes carry the owner in the SQL `WHERE` (`ownerPredicate`), not only a route pre-check (#174's check-then-act lesson).
- A pool config may only fall back to a pool config; a course config may fall back to the pool or its own course.
- Homework pinning (`llmConfigBelongsToOrg`) requires visibility to the pinning course.
- Audit metadata carries `level`: `organization` or `course`.
- The admin console derives editability from `scopeCourseId` + the list response's `canManageOrgPool` and never offers an action the server refuses; read-only shared configs use a disabled `admin-form-lock` fieldset with the test panel outside it.

## Not changed

The Canvas credential (`routes/canvasCredentials.ts`) still has the same course-to-org widening; M11 made it instructor-pasted on purpose, so narrowing it to Org Admin is a separate product decision.
