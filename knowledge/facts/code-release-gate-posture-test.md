---
type: Fact
title: Grader-tier routes must declare a release-gate posture
description: requireGraderOf takes a posture (gates-unreleased or no-unreleased-content); releaseGate.test.ts fails until each new grader route is listed; runtime logs flag gates-unreleased handlers that skip canViewDraftsIn.
tags: [authorization, testing, routes]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:30:53Z" }
status: stable
governance: constraint
code_refs: ["apps/web/src/server/utils/guards.ts", "apps/web/src/server/releaseGate.test.ts", "apps/web/src/server/routeGuards.test.ts", "apps/web/src/server/index.ts"]
sources:
  - resource: "apps/web/src/server/utils/guards.ts"
  - resource: "apps/web/src/server/index.ts"
---

TAs (grader tier) can read student work but may not see unreleased (draft, scheduled, hidden) homework unless the instructor granted `canViewDrafts` on their membership. Routes that serve grader-tier reads are registered with `requireGraderOf(posture)`:

- `"gates-unreleased"`: the handler itself calls `authContext.canViewDraftsIn(courseId)` and withholds, 404s or filters unreleased content. Used by submissions, transcripts (list and detail), feedback, and section answers. Transcripts count as unreleased content because the greeting and replay are built from the section as it stood.
- `"no-unreleased-content"`: the route cannot return unreleased content by construction; justify it in a comment at the call site.

The posture is stamped on the handler under the symbol `RELEASE_GATE_POSTURE` and read by `releaseGatePostureOf`. `apps/web/src/server/releaseGate.test.ts` enumerates registered routes and **fails until a newly added grader-tier route is listed with its posture**, so reviewers see the claim. At runtime, a `gates-unreleased` handler that answers 2xx without consulting the gate is logged, so a false claim shows up in production logs.

Related guard rules from server/index.ts comments:

- Authoring and grade writes stay on `requireInstructorOf`. A TA may read work but not grade it (#75); TA grading would be a per-course grant like `canViewSolutions`, not a widened guard.
- TA management and roster changes are instructor-only (#172, #210).
- `requireInstructorOf` is also applied belt-and-braces on knowledge routes even though handlers mint scope via `instructorScope()` (which requires authoring authority, unlike `courseScopeFromAuthContext`, which a student satisfies).
- `routeGuards.test.ts` pins which guard wraps each route by replacing handlers with spies and asserting the handler was never invoked for refused personas (status alone could not tell guard refusal from a handler's defensive re-check). Update it when adding or re-tiering a route.
- Unguarded routes (`/api/chat`, `/api/conversations*`, feedback flagging) enforce ownership inside the handler via `getOwnedConversationOrNull`.
