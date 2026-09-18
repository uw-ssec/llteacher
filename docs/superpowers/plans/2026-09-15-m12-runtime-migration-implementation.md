# M12 Node Runtime Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the web and admin SPAs plus Hono API from one Node 24 container backed by `pg`.

**Architecture:** A Node entry mounts static builds at `/` and `/admin`, delegates `/api/*` to the existing Hono app, and passes a typed process-environment object to handlers. A shared `pg` pool replaces the Neon HTTP driver.

**Tech Stack:** Node 24, Hono Node adapter, `pg`, Drizzle node-postgres, Vite, Vitest, Docker.

**Spec:** `docs/plan/2026-09-15-m12-local-aws-design.md`

## Global Constraints

- Preserve same-origin API routes and existing role guards.
- Serve web at `/` and admin at `/admin` from one image.
- Do not retain Cloudflare runtime dependencies or Neon HTTP code.
- Migrations must complete before an app service update.

---

### Task 1: Node runtime configuration and database client

**Files:** modify `apps/web/src/db/client.ts`, `apps/web/src/shared/types.ts`, `apps/web/package.json`; create `apps/web/src/runtime/config.ts` and `apps/web/src/runtime/config.test.ts`.

**Produces:** `loadRuntimeConfig(env: NodeJS.ProcessEnv): Env` and a `makeDb(databaseUrl: string)` backed by `pg`.

- [x] Write failing tests that reject a missing `DATABASE_URL` and verify `makeDb` uses the node-postgres client.
- [x] Run `npm run test --workspace=llteacher-web -- src/runtime/config.test.ts`; expect failure because the module is absent.
- [x] Implement `loadRuntimeConfig` with the existing `Env` keys, `DATABASE_URL` validation, and no `ASSETS` binding; replace Neon imports and dependency with `pg` and `drizzle-orm/node-postgres`.
- [x] Re-run the focused test and `npm run typecheck --workspace=llteacher-web`.
- [x] Commit: `refactor(web): use Node runtime configuration and pg`.

### Task 2: Same-container static routing and Node server

**Files:** modify `apps/web/src/server/index.ts`, `apps/web/vite.config.ts`, `apps/web/package.json`; create `apps/web/src/node/server.ts`, `apps/web/src/node/server.test.ts`.

**Produces:** `createNodeServer(config: Env)` serving `/`, `/admin`, and `/api/*` on `PORT`.

- [x] Write failing HTTP tests for `/`, `/admin`, `/admin/any/client/route`, and `/api/hello` using temporary web/admin build directories.
- [x] Run the focused Vitest file; expect an import/module failure.
- [x] Implement the Node adapter with Hono Node serving and explicit static fallbacks: web `index.html` for non-API routes, admin `index.html` below `/admin`, and no asset fallback for unmatched `/api/*`.
- [x] Remove Worker-only default export, `scheduled()` export, `ASSETS` use, Wrangler/Vite plugin wiring, and `.dev.vars` parsing; retain a Vite proxy to the Node API server for development.
- [x] Run focused tests, `npm run build`, and `npm run test --workspace=llteacher-web`.
- [x] Commit: `feat(web): run Hono and both SPAs on Node`.

### Task 3: Container and overdue-job command

**Files:** create `Dockerfile.aws`, `apps/web/src/node/run-overdue-job.ts`; modify root `package.json`, `apps/web/package.json`, `apps/web/src/server/jobs/autoSubmitOverdue.ts`; create `apps/web/src/node/run-overdue-job.test.ts`.

- [x] Write a failing test proving the job command calls the existing sweep once and closes the database pool on success or failure.
- [x] Build a multi-stage Node 24 image containing both SPA builds and the Node server; add `node:run-overdue-job` that loads runtime config, invokes the sweep, then exits.
- [x] Run the focused test and `docker build -f Dockerfile.aws -t llteacher:local .`.
- [x] Smoke-test `docker run --rm -p 8080:8080 llteacher:local`, then request `/` and `/admin`.
- [x] Commit: `feat(deploy): package app and overdue job for ECS`.
