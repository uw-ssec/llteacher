---
type: Fact
title: Dev ports and API proxy targets
description: "Web Vite 2311 proxies /api to NODE_API_URL (default localhost:3000, npm run node:serve); admin Vite 2312 proxies to LLTEACHER_API_URL (default localhost:8080, the container/Floci port); both use strictPort."
tags: [dev, ports, vite, proxy, gotcha]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:30:53Z" }
status: stable
governance: constraint
code_refs: ["apps/web/vite.config.ts", "apps/admin/vite.config.ts", "apps/web/src/node/server.ts", "infra/scripts/floci-up.sh", "docs/architecture/dev-api-proxy.md"]
sources:
  - resource: "apps/web/vite.config.ts"
  - resource: "apps/admin/vite.config.ts"
  - resource: "apps/web/README.md"
  - resource: "docs/architecture/dev-api-proxy.md"
---

| Port | What | Source |
|---|---|---|
| 2311 | apps/web Vite dev/preview (`strictPort`) | apps/web/vite.config.ts |
| 2312 | apps/admin Vite dev/preview, base `/admin/` (`strictPort`) | apps/admin/vite.config.ts |
| 3000 | `npm run node:serve` default (`PORT` env) | src/node/server.ts |
| 8080 | Container `PORT` (Dockerfile.aws), CI image smoke, Floci ALB HTTP | Dockerfile.aws, floci-up.sh |
| 8443 | Floci plaintext socket for the modeled HTTPS listener (`domainReady=true`) | floci-up.sh |
| 4566 | Floci AWS API emulator | floci-up.sh |
| 5432 | Postgres (CI service) | test.yml |

**`npm run dev` (root) starts only the two Vite servers.** It does not start the API. Without `npm run node:serve` in another terminal, `/api/*` through the proxy returns 500 (verified: `curl localhost:2311/api/health` -> 500 with no API running). `predev` copies WebR assets into `apps/web/src/client/public/webr` (gitignored).

**Admin proxy mismatch.** `apps/admin/vite.config.ts` proxies `/api` to `process.env.LLTEACHER_API_URL ?? "http://localhost:8080"` with `changeOrigin: false`. Its comment and apps/web/README.md say admin goes "through the web proxy", but the default actually targets port 8080 (a running container or the Floci stack), not 2311 or 3000. For the plain dev setup, start admin with `LLTEACHER_API_URL=http://localhost:2311` (cookie stays same-host) or `http://localhost:3000`. Uncertain whether 8080 is intentional; check git history before "fixing".

**Cross-origin isolation.** Vite (dev and preview), the Node outer app and the Hono app all set `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (#368, WebR SharedArrayBuffer). Any new cross-origin subresource (CDN script, font, image) will be blocked; self-host it.

**WorkOS callback** must match the origin you browse: `${APP_URL}/api/auth/callback`. For Floci it is `http://localhost:8080/api/auth/callback`. README notes local ports 2311/2312 and 2411/2412 are paired automatically for the staff "teaching workspace" link (`VITE_ADMIN_URL`).
