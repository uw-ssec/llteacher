---
type: Decision
title: "Turborepo with a student SPA, an instructor SPA, and one shared Hono API"
description: apps/web holds the student React app plus the only backend (Hono under /api); apps/admin is a separate React SPA with no server that calls the same-origin API; packages/ui is shared.
tags: [architecture, monorepo, frontend, hono]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:32:34Z" }
status: stable
governance: context
code_refs: [apps/web/src/server/index.ts, apps/web/src/node/server.ts, apps/admin/src/client/App.tsx, packages/ui/src, turbo.json, package.json, docs/architecture/admin-console.md]
sources:
  - resource: docs/superpowers/plans/2026-06-01-llteacher-fullstack-port.md
  - resource: docs/architecture/admin-console.md
  - resource: docs/superpowers/plans/2026-09-15-m12-milestone-findings.md
  - resource: docs/architecture/dev-api-proxy.md
---

## Spec proposed
The port plan put everything under one `web/` directory: React client, Hono server, and Drizzle, all on one Cloudflare Worker. The admin replacement (phase 8) was left open: a curated React surface, `drizzle-kit studio`, or a third-party admin.

## Implemented
The repo is an npm-workspaces Turborepo. The workspaces are `apps/web`, `apps/admin`, `packages/*`, `evals`, and `infra`.
- `apps/web` holds the student React 19 app *and* the only backend: a Hono app in `src/server`, with repositories, jobs, knowledge, and storage.
- `apps/admin` is the instructor console. It is a separate Vite SPA with no router: view state is a tagged union in `App.tsx`. Its "editorial catalog" visual vocabulary (`HW·003`-style RecordIds) is described in `docs/architecture/admin-console.md`. It has **no server of its own** and calls `apps/web`'s `/api/*`.
- `packages/ui` holds shared components, the API wire types (`src/api/types.ts`), and generative-UI renderers.

In development, Vite (port 2311) proxies `/api` to the Node Hono server (port 3000). The admin dev server uses port 2312. In production, one Node process serves the web SPA at `/`, the admin SPA at `/admin`, and the API at `/api` (`apps/web/src/node/server.ts`).

## Why
M12 findings compared two independent services with one full-app service. The admin "is a frontend that consumes the web app's API", so a second service would be an operational boundary, not a domain boundary. That comparison chose one service.

## Rejected alternatives
- Two ECS services with an admin-to-web proxy. Revisit only if the admin gains its own backend or needs to scale on its own.
- `drizzle-kit studio` or a third-party admin in place of an instructor console.

## Consequences
- Route guards and role checks in the Hono app are the *only* thing separating instructor from student functionality. Both SPAs share one origin, one cookie, and one deploy.
- A failed rollout affects both portals at once.
- Wire types in `packages/ui` are checked at compile time against repository record types, so client/server drift shows up as a typecheck failure.

# Related Concepts
- [Request path: Node adapter, Hono API, SPA fallbacks](../architecture/request-path.md): How requests flow through the one API and two SPAs
- [Instructor admin console (apps/admin)](../architecture/admin-console.md): The instructor SPA
- [Dev ports and API proxy targets](../facts/code-dev-ports-and-proxy.md): Dev ports and proxies for the two SPAs and the API
- [turbo typecheck race between evals and web](../facts/code-turbo-evals-typecheck-race.md): A turbo pipeline subtlety of the monorepo
- [TypeScript 7 in apps, 5.9 in infra; stale node_modules breaks typecheck](../facts/code-typescript-and-install.md): TypeScript versions and installs across workspaces
- [.gitignore lib/ must stay root-anchored](../facts/code-gitignore-lib-anchoring.md): A gitignore footgun that hit workspace source dirs
