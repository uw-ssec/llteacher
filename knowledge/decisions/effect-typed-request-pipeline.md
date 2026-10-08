---
type: Decision
title: API handlers run as Effect 4 programs with typed errors
description: "Every Hono handler is an Effect<Response, E, R>; effectHandler accepts only E within the closed HttpError set and R within Database|AppConfig, so an untranslated refusal or unprovided dependency is a compile error."
tags: [effect, errors, api, architecture]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-08T17:49:24Z" }
status: stable
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

# Related Concepts
- [Truncated or non-replayable assistant turns poison chat idempotency](../bugs/partial-stream-persisted-as-complete.md): Same chat turn-finalization path: the Effect migration found that a provider rejection before any stream existed left the turn unfinalized and its lock held, returning false 409 in_progress on retry.
