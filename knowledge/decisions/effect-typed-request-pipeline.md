---
type: Decision
title: API handlers run as Effect 4 programs with typed errors
description: "Every Hono handler is an Effect<Response, E, R>; effectHandler accepts only E within the closed HttpError set and R within Database|AppConfig, so an untranslated refusal or unprovided dependency is a compile error."
tags: [effect, errors, api, architecture]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-08T18:32:43Z" }
status: stable
governance: constraint
code_refs: ["apps/web/src/server/effect/**", "apps/web/src/server/routes/**", apps/web/src/server/middleware/roles.ts, apps/web/src/runtime/config.ts, docs/architecture/effect.md]
sources:
  - resource: "PR #478"
  - resource: "issue #477"
---

## Decision

The Hono API (apps/web/src/server) runs every route handler, rolesMiddleware's DB reads, and runtime config loading through Effect 4 (effect@4.0.2). Code: apps/web/src/server/effect/. Contract and the full list of errors the migration surfaced: docs/architecture/effect.md.

## Invariants to keep

- Repository calls go through query(op, db => ..., [ExpectedRefusalClasses]); third-party calls through external(service, op, ...). Listing a class keeps it typed; anything else becomes DatabaseError (reason unavailable|constraint|query from SQLSTATE) or ExternalServiceError, logged as one JSON line with tag/operation/reason|service and answered with the generic 503.
- Refusal classes stay Error subclasses (instanceof callers keep working) and carry readonly _tag = "Name" as const so Effect.catchTag can name them.
- errorResponse in effect/http.ts is the single status mapping, shared with app.onError via fromThrown; it is exhaustive (absurd), so a new HttpError member without a case fails the build.
- Middleware calls runEffect, never wraps next() in the Effect: downstream throws must still reach app.onError.
- Statuses with no HttpError member (413, 422, 429 + Retry-After, 502, custom-body 503, chat's coded bodies via its local ChatRefusal) are built in the route from the success channel; do not widen HttpError per route.

## Rejected alternatives

- Rewriting repositories to return Effect: far larger diff against modules other branches edit; wrapping at the call site gives the same typed surface.
- Effect's Config/ConfigProvider for runtime config: short-circuits on the first missing variable with generic messages; runtimeConfig accumulates every problem into one RuntimeConfigError instead.

## Verification

src/server/effect/e2e.integration.test.ts boots the real Node server (child process) against a freshly created and migrated Postgres and produces real failures: unreachable DB (DatabaseError unavailable, 503), a table renamed under a running server (DatabaseError query naming the operation, then recovery), and missing config (startup refused, every variable named).

## Bug classes the migration surfaced (PR #478, merged 2026-10-08)

Typing the error channels turned up these bugs, which were already in `staging`. They are worth knowing because new code written with `throw`/bare `catch` brings them back:

- **Outages reported as routine answers.** A bare `catch` mapped every failure to the expected refusal. A database outage answered 403 on `PATCH /sections/:id/answer` and `PATCH /widgets/:id/response`. `createCollection` answered every failure, outages included, with 409 "name already exists". A DB failure after a successful Canvas sync answered 502 and marked the sync failed.
- **Client errors reported as outages.** Deleting a submitted conversation answered 503 (now 409). An unknown widget id answered 503 (now 422). A malformed multipart body or `%` escape answered 503 (now 400).
- **Chat turn left locked.** When the provider rejected a request before any stream existed, `onFinish` never ran, so the turn lock stayed held for 90 s and every Retry got a false 409 `in_progress`. Lock release is now `Effect.onError` around the locked phase.
- **Database text leaked.** A `/order|section/` regex echoed raw Postgres text in a 422, and `requestHint` sent the raw driver error to the model, which persisted it with the turn.

Related issues of the same class, not verified against the new code: #236, #238, #241, #251, #254.

## Open questions left by the PR

- A WorkOS outage in the `routes/auth.ts` callback still answers 401, because an existing test pins it. It is now logged with `service: "workos"`. Whether it should be a 503 is a product decision that nobody has made.
- `routes/homeworks.ts`: values Postgres rejects (SQLSTATE 22xxx, 23502, 23514) answer a fixed-message 422. Every other update failure is a 503.

## Testing note

Route suites still mock repository modules and `makeDb`. The `Database` layer calls the mocked `makeDb`, so the existing route tests double as regression tests for the bridge. `src/server/effect/http.test.ts` holds `@ts-expect-error` contract tests: removing one makes `tsc -b` name the untranslated refusal.

# Related Concepts
- [Truncated or non-replayable assistant turns poison chat idempotency](../bugs/partial-stream-persisted-as-complete.md): Same chat turn-finalization path: the Effect migration found that a provider rejection before any stream existed left the turn unfinalized and its lock held, returning false 409 in_progress on retry.
