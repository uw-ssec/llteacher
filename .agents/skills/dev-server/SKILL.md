---
name: dev-server
description:
  Use when running the student web app, the instructor admin console, or the
  Hono API locally for development, or when a dev server fails to start or its
  /api proxy errors.
---

# Dev Server

Development runs three processes: the Hono API on Node (port 3000) and two Vite
servers — web on **2311**, admin on **2312** (base `/admin/`). In production and
in the container everything is one port, 8080.

## Commands (repository root, after `npm ci`)

```bash
# Terminal 1 — the API. It reads no .env file: export the variables first.
export APP_URL=http://localhost:2311          # bare origin you browse; used for the WorkOS redirect
export DATABASE_URL=postgres://llteacher:dev@localhost:5432/llteacher   # a local, migrated Postgres
export LLMOXIE_BASE_URL=<non-production gateway URL> LLMOXIE_API_KEY=...
export WORKOS_API_KEY=... WORKOS_CLIENT_ID=... WORKOS_WEBHOOK_SECRET=...
export SESSION_SECRET=... ENCRYPTION_KEY=... BLIND_INDEX_KEY=...
export KNOWLEDGE_ROOT="$PWD/.knowledge"       # not a symlinked path (macOS /tmp fails)
npm run node:serve

# Terminal 2 — both Vite servers (or one with --workspace)
npm run dev
npm run dev --workspace=llteacher-web
LLTEACHER_API_URL=http://localhost:3000 npm run dev --workspace=llteacher-admin
```

Static pages load without the API; anything under `/api` returns 500 through the
proxy until terminal 1 is running. Check the API directly with
`curl localhost:3000/api/health`.

## Proxies and ports

| Server | Port | `/api` goes to                                                                  |
| ------ | ---- | ------------------------------------------------------------------------------- |
| web    | 2311 | `NODE_API_URL`, default `http://localhost:3000`                                 |
| admin  | 2312 | `LLTEACHER_API_URL`, default `http://localhost:8080` (the container/Floci port) |

Both use `strictPort`: "Port 2311 is already in use" means stop the other
process, not pick another port. Both send COOP/COEP headers, which WebR needs
for `SharedArrayBuffer` (#368); cross-origin assets must be self-hosted.

## Common failures

| Symptom                                       | Cause / fix                                                                                                           |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `Error: APP_URL is required` (or another var) | Export it; `apps/web/README.md`'s list omits `APP_URL`.                                                               |
| Login loops                                   | `APP_URL` differs from the browser origin, or `${APP_URL}/api/auth/callback` is not registered in the WorkOS dev app. |
| `makeDb received a different DATABASE_URL`    | The pool is a process singleton; restart the API.                                                                     |
| Admin `/api` hits the wrong backend           | Set `LLTEACHER_API_URL`; a running Floci stack on :8080 answers otherwise.                                            |
| Scanned-PDF extraction fails                  | Install poppler (`brew install poppler`).                                                                             |

## Rules

- NEVER start the API with `LLMOXIE_API_KEY` and no `LLMOXIE_BASE_URL`: it falls
  back to the production gateway and bills production.
- NEVER put secrets in `VITE_*` variables; they ship to the browser.
- Never point the dev API at a shared or production database.
- Do not "fix" the admin :8080 default or the COOP/COEP headers without reading
  their history first
  (`pixi run okf search --for-path apps/admin/vite.config.ts`).

## Done

The servers you need answer (`curl -sI localhost:2311/`,
`curl -sI localhost:2312/admin/`, and `curl localhost:3000/api/health` when the
API is involved), and the report says which processes ran with which ports.
