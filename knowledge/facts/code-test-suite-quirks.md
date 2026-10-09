---
type: Fact
title: "Test-suite quirks that cost time: auth middleware mocks, jsdom fieldsets, a parallel-run flake"
description: "Adding a query to rolesMiddleware breaks three test files' db mocks; jsdom needs :disabled to see fieldset-disabled controls; one admin test flakes under the full parallel turbo run."
tags: [testing, vitest, jsdom, mocks, flaky]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-08T20:53:11Z" }
status: stable
governance: constraint
code_refs: ["apps/web/src/server/middleware/roles.ts", "apps/web/src/server/middleware/roles.test.ts", "apps/web/src/server/index.test.ts", "apps/web/src/server/routeGuards.test.ts", "apps/web/src/server/testing/authContext.ts"]
sources:
  - resource: "PR #484"
---

Found on 2026-10-08 while landing #367; each cost a debugging round.

## rolesMiddleware runs on every request, and three suites mock its database

Adding a query to `server/middleware/roles.ts` (here `listOrgAdminOrgIdsForUser`) failed 168 tests: `middleware/roles.test.ts`, `server/index.test.ts` and `server/routeGuards.test.ts` each mock `makeDb` with only the relational builder (`db.query.<table>.findMany`). Write middleware reads with `db.query.*` (as `listMembershipsForUser` does) and add the new table to all three mocks. The same per-request query also means a deploy must run its migration first, which the release pipeline already guarantees (requirements/migrate-before-deploy).

## jsdom and disabled fieldsets

A control inside `<fieldset disabled>` is disabled to users but its own `.disabled` property stays false in jsdom. Assert `element.matches(":disabled")`, which reflects the inherited state.

## Fake auth sessions are not uuids

`fakeAuthContext` uses `session.userId = "u1"`. A handler that writes the caller's id into a uuid column (e.g. `granted_by_user_id`) fails with a 503 against a real database; give the test a real `users` row and override `session.userId`.

## Known flake

`apps/admin`'s "Unsaved changes" test failed once during a full `npm test` across all workspaces in parallel, and passed in three isolated runs of the admin suite. Re-run before treating it as a regression.

## Related

The incremental `tsc -b` false pass is recorded in facts/code-typescript-and-install.

# Related Concepts
- [TypeScript 7 in apps, 5.9 in infra; stale node_modules breaks typecheck](code-typescript-and-install.md): The other verification trap from the same session
- [Org Admin owns the shared LLM config pool; course instructors own course-scoped configs](../decisions/org-admin-role-and-course-scoped-configs.md): The change that surfaced these quirks
