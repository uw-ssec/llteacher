---
type: Architecture
title: LLTeacher v2 system overview
description: "TypeScript Turborepo (apps/web student app + Hono API, apps/admin console, packages/ui, evals, infra) shipped as one Node 24 ECS image; legacy Django still lives alongside until cutover."
tags: [architecture, monorepo, overview]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:32:36Z" }
status: stable
governance: context
code_refs: [package.json, turbo.json, apps/web, apps/admin, packages/ui, evals, infra, Dockerfile.aws]
sources:
  - resource: README.md
  - resource: package.json
  - resource: turbo.json
  - resource: infra/README.md
  - resource: 5ff05e1
  - resource: b1174be
---

LLTeacher v2 is an AI tutoring platform being ported from Django to TypeScript. The repo is an npm-workspaces Turborepo (`package.json` workspaces: `apps/web`, `apps/admin`, `packages/*`, `evals`, `infra`; Node `>=24`, `.nvmrc` = 24).

**Workspaces (npm package names matter for `--workspace=`):**

| Dir | Package | Role |
|---|---|---|
| `apps/web` | `llteacher-web` | Student SPA (Vite/React 19/Tailwind 4, root `src/client`) **and** the whole Hono API (`src/server`), Drizzle schema/migrations (`src/db`), Node entry (`src/node/server.ts`) |
| `apps/admin` | `llteacher-admin` | Instructor console SPA, served under `/admin/`; has no server of its own, calls the same `/api` |
| `packages/ui` | `@llteacher/ui` | Shared design system, role vocabulary mirror, API types; consumed as TS source (no build step) |
| `evals` | `llteacher-evals` | Tutor-behavior / answer-leakage harness |
| `infra` | `infra` | Pulumi AWS program + release/local shell scripts |

**Runtime shape:** one container (`Dockerfile.aws`) runs `npm run node:serve` -> `tsx apps/web/src/node/server.ts` on port 8080. That Node process serves the API at `/api/*`, the admin build at `/admin`, and the web build at `/`. Postgres (RDS 16 + pgvector) via node-postgres; uploads and knowledge snapshots in S3; course knowledge is an OKF bundle searched by the pinned `okf` binary.

**History an agent must know:** the port started on Cloudflare Workers + Neon (`neon-http`), then moved to Node + `pg` on AWS ECS Fargate (commits `5ff05e1`, `b1174be`). Many comments and some docs (apps/web/ARCHITECTURE.md, apps/admin/README.md) still describe the Worker era; trust the code. AWS + Pulumi is the settled target.

**Legacy:** Django apps (`apps/accounts`, `apps/conversations`, `apps/homeworks`, `apps/llm`), `src/llteacher`, `services/` remain, run via uv, and the root README still calls them the source of truth until cutover. npm and uv ignore each other's manifests.

# Related Concepts
- [Request path: Node adapter, Hono API, SPA fallbacks](request-path.md): Entry point of a request
- [AWS infrastructure topology (Pulumi, ECS Fargate)](infra-topology.md): Where the system runs
