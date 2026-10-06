---
type: Bug
title: "memberships[0] from an unordered query picked an arbitrary course"
description: "Chat turns without a conversationId were filed under authContext.memberships[0] from a query with no ORDER BY, so the course was arbitrary and could change between requests; fixed by sending a resolved courseId."
tags: [chat, multi-tenancy, postgres, authz]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:25:31Z" }
status: stable
governance: constraint
code_refs: ["apps/web/src/server/routes/chat.ts", "apps/web/src/server/middleware/roles.ts"]
sources:
  - resource: "issue #304"
  - resource: "PR #413"
  - resource: "PR #434"
---

## Root cause (#304, audit of PR #212)

```ts
const fallbackCourseId = requestedCourseId ?? authContext.memberships[0]?.courseId;
```

`listMembershipsForUser` used `findMany` with no `orderBy`. Postgres guarantees no order without one, so `[0]` was arbitrary and could differ between two requests from the same user. The tutor rail never sent a `courseId`, so for any student in more than one course, tutor conversations (and the LLM config and budget that follow from the course) could land in the wrong course. The codebase already knew the hazard: `ProfileService.ts` had a comment warning about exactly this `memberships[0]` pattern.

## Fix

- PR #413: the tutor rail sends a real, resolved `courseId`/`courseName` on every turn. Requirement 1 makes the server return 400 for a request with neither `conversationId` nor `courseId`, instead of guessing.
- PR #434 fixed the knock-on bug: the tutor Retry still sent `{}` when no conversation row existed yet, so a student whose first turn failed got a second, worse error on Retry.

## Rules

- Never take `[0]` of an unordered result as a business decision. Either require the caller to name the scope or add a deterministic ORDER BY with a documented meaning.
- The platform is multi-course and multi-org by design. Assume users have more than one membership. Similar defects: #239 (restart resolves the org from the caller rather than the course in the path) and #294 (nav hardcoded course, term and initials).
