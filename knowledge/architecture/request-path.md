---
type: Architecture
title: "Request path: Node adapter, Hono API, SPA fallbacks"
description: "src/node/server.ts wraps the API-only Hono app: /api/* goes to the app before any SPA fallback, /admin/* serves the admin build, everything else the web build; COOP/COEP set on every response."
tags: [architecture, hono, routing, node]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:30:53Z" }
status: stable
governance: context
code_refs: ["apps/web/src/node/server.ts", "apps/web/src/server/index.ts", "apps/web/src/server/middleware/auth.ts", "apps/web/src/server/middleware/roles.ts", "apps/web/src/runtime/config.ts"]
sources:
  - resource: "apps/web/src/node/server.ts"
  - resource: "apps/web/src/server/index.ts"
  - resource: "docs/architecture/dev-api-proxy.md"
---

**Production/container path:** `startNodeServer()` (apps/web/src/node/server.ts) calls `loadRuntimeConfig(process.env)` (fails fast on missing required vars), creates the pg pool via `makeDb`, kicks off `recoverInterruptedExtractions`, starts the hourly overdue scheduler, and serves a small outer Hono app:

1. `/api` and `/api/*` -> `app.fetch(req, config)` where `app` is the API-only Hono app exported from `apps/web/src/server/index.ts`. Config is passed as the Hono `env` (`c.env.DATABASE_URL` etc.), a holdover from the Workers binding model.
2. `/admin`, `/admin/*` -> static files from `apps/admin/dist/admin`, falling back to its `index.html`.
3. `*` -> static files from `apps/web/dist/client`, falling back to `index.html`.

Order matters: API routes are registered before both SPA fallbacks, and the API app ends with `app.all("/api/*", ...)` returning a JSON 404 (#172 CMP-005) so a missing route can never return `index.html` with 200.

**Inside the API app** (server/index.ts): middleware order is COOP/COEP headers (for WebR SharedArrayBuffer, #368) -> `authMiddleware` (sealed cookie; 401 unless path in the closed set `PUBLIC_API_PATHS`) -> `rolesMiddleware` (one DB round-trip loading memberships + activation state, builds `AuthContext`). Routes are registered flat on `app` (not `app.route(prefix, sub)`) to avoid Hono prefix-stripping. Each route is wrapped in a guard from `server/utils/guards.ts` (`requireCourseMember`, `requireInstructorOf`, `requireGraderOf(posture)`, `requireRole`, `requireSuperAdmin`); some (e.g. `/api/chat`, `/api/conversations/:id`) are unguarded and enforce ownership in the handler.

`app.onError` maps `TenancyMismatchError` -> 404, `IdempotencyKeyConflictError` -> 409 with `code: duplicate_message`, `PromptTemplateConflictError` -> 409, everything else -> logged + generic 503.

`/api/health` returns `{status, version: BUILD_SHA}`; the release workflow verifies the deployed version through it.

**Dev path:** Vite on 2311 proxies `/api` to `NODE_API_URL` (default `http://localhost:3000`, where `npm run node:serve` listens). See facts/code-dev-ports-and-proxy.
