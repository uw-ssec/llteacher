---
type: Decision
title: Shared-schema multi-tenancy with denormalized tenant columns and branded scope types
description: "One Postgres schema holds all tenants; leaf tables carry organization_id or course_id, and repository functions take a branded OrgScope or CourseScope so unscoped queries fail to compile. Schema-per-tenant was rejected."
tags: [data-model, tenancy, repositories, typescript]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:32:35Z" }
status: stable
governance: constraint
code_refs: [apps/web/src/server/repositories/scope.ts, apps/web/src/server/repositories, apps/web/src/server/middleware/roles.ts, apps/web/src/server/utils/guards.ts, apps/web/src/db/schema/runtime.ts, apps/web/ARCHITECTURE.md]
sources:
  - resource: docs/architecture/multi-tenant-data-model.md
  - resource: docs/superpowers/plans/2026-08-03-m2-runtime-persistence.md
  - resource: apps/web/ARCHITECTURE.md
  - resource: "PR #127"
  - resource: commit 9e9e3ae
---

## Spec proposed
`docs/architecture/multi-tenant-data-model.md` §3.3 compared three options. The shared schema with an `org_id` column was recommended for the three FERPA-only projects. Schema-per-tenant (django-tenants) was held in reserve for Clinical Informatics if UW-IT requires HIPAA-grade isolation. Database-per-tenant was judged overkill. The doc proposed a mandatory org-scoped queryset and an `org_id` denormalized onto every leaf, **including `conversations`/`messages`**.

## Implemented (M2, PR #127)
- Runtime leaf tables `submissions`, `grades`, `citations`, `llm_call_logs`, `student_profiles`, and `audit_events` carry an indexed `organization_id`.
- **Divergence:** `conversations` and `messages` carry `course_id`, not `organization_id` (M2 decisions 4/5).
- `repositories/scope.ts` defines the branded `OrgScope` and `CourseScope` types.
- Raw constructors were renamed `unsafeOrgScope` and `unsafeCourseScope` (#135). The sanctioned route path is `courseScopeFromAuthContext(authContext, courseId)`, which returns `null` unless the caller is an active member.
- Write functions check the parent chain before writing denormalized tenancy columns (#132), which closes the IDOR risk.
- Routes and middleware contain no direct Drizzle queries.
- **Doc drift:** `apps/web/ARCHITECTURE.md` "Tenancy Enforcement" still refers to `orgScope(id)` / `courseScope(id)`, but the code exports the `unsafe*` names.

## Why
A shared schema is cheap, has one migration story, and supports cross-org analytics. Branded types make "forgot the WHERE clause" a compile error, not a code-review hope.

## Rejected alternatives
- Schema-per-tenant and database-per-tenant (deferred, not ruled out for HIPAA).
- Postgres RLS (not discussed; inferred unused).
- A single scope type. It was rejected because `conversations` has no `organization_id`.

## Consequences
- Scopes answer *which tenant*, not *which row owner*. Ownership is a route-layer duty (see `requirements/tenant-scoped-data-access`).
- A HIPAA tenant may still force a schema-level change.

# Related Concepts
- [Data access is tenant-scoped: repositories take a branded scope, and routes check ownership](../requirements/tenant-scoped-data-access.md): The invariant the scopes enforce
- [Data model and shared-schema multi-tenancy](../architecture/data-model-multi-tenancy.md): The data model as built
- [memberships[0] from an unordered query picked an arbitrary course](../bugs/unordered-memberships-first-row.md): A tenancy bug from an unordered membership query
- [Org deletion bypasses RESTRICT FKs because of cascade ordering](../bugs/org-delete-cascade-order.md): Cascade ordering across tenant tables
