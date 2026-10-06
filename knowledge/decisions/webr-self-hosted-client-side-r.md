---
type: Decision
title: "R runs in the browser with self-hosted, exact-pinned WebR under COOP/COEP isolation"
description: "Student R code runs client-side in WebR 0.6.0 served from the app's own origin (/webr/), copied from node_modules at build, with cross-origin isolation headers; the original unpinned webr.r-wasm.org/latest CDN load was rejected."
tags: [r-execution, frontend, security, parity]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:32:35Z" }
status: stable
governance: constraint
code_refs: [apps/web/src/client/hooks/useWebR.ts, apps/web/src/client/hooks/useRExecution.ts, apps/web/scripts/copy-webr-assets.mjs, apps/web/src/node/server.ts, apps/web/vite.config.ts, apps/web/package.json]
sources:
  - resource: docs/architecture/webr-self-hosting.md
  - resource: docs/superpowers/plans/2026-06-01-llteacher-fullstack-port.md
  - resource: docs/okf-feature-review-2026-09-16.md
  - resource: commit 2f87a18
  - resource: commit a6fb4c5
---

## Spec proposed
The port plan kept R execution client-side and loaded WebR from `https://webr.r-wasm.org/latest/webr.mjs`, as the Django app did ("unchanged"). Phase 6 asked how to load it and whether to wire the unused server-side `handleRCodeExecution`.

## Implemented
PR #366 (commit `2f87a18`) added R execution and the instructor transcript viewer. Its review (#368/#369) **rejected the CDN load**: `latest` is unpinned code running in an authenticated origin, and the old `SW_URL` option was not a real field. Current state:
- `webr` is an exact-pinned dependency (`0.6.0`). `scripts/copy-webr-assets.mjs` copies `node_modules/webr/dist` into `src/client/public/webr/` at predev/prebuild. The copy is gitignored.
- `useWebR.ts` loads `${origin}/webr/webr.js`. That is the browser export condition. `webr.mjs` imports Node built-ins and breaks in browsers. The URL is computed at runtime to get past Vite's public-dir import guard.
- `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` are set by Vite in development and by the Node static server on pages and SPA fallbacks. The OKF review fixed a regression here. The headers let WebR use `SharedArrayBuffer`, with `PostMessage` as a fallback.
- WASM-binary package installs make the tidyverse work (commit `a6fb4c5`, #374).

## Why
Reproducible builds. No third-party code in the authenticated origin. No server-side R sandbox to run or secure.

## Rejected alternatives
- An unpinned CDN.
- A service-worker channel (not in this WebR version).
- Server-side R execution.

## Consequences
- Upgrading WebR is a manual, browser-tested change (no CI check, per the doc).
- COOP/COEP constrain embedding third-party resources, such as WorkOS redirects or images, in app pages.
- True interrupt recovery is an accepted M4 limitation.

# Related Concepts
- [WebR install.packages silently failed; tidyverse never loaded](../bugs/webr-source-package-install-fails.md): A WebR package-install bug
- [Dev ports and API proxy targets](../facts/code-dev-ports-and-proxy.md): COOP/COEP headers the dev servers send for WebR
