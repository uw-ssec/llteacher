# WebR Self-Hosting

How the client-side R runtime (`webr`, used by [useWebR.ts](../../apps/web/src/client/hooks/useWebR.ts) and [useRExecution.ts](../../apps/web/src/client/hooks/useRExecution.ts)) is loaded, served, and isolated. Written after PR #366's review (#368/#369) replaced a third-party-CDN load with a self-hosted one.

## Why it exists

The original implementation loaded WebR straight from `https://webr.r-wasm.org/latest/webr.mjs`. Review caught two real problems, neither exercised by any test (every unit test mocks the dynamic import out):

- **`latest` is not pinned.** What code runs in this authenticated origin could change with no repo change, no review, and no reproducible build.
- **No self-hosting story, unverified against a real browser.** The old code also passed a `SW_URL` option that isn't a real field on this version's `WebROptions` at all — it silently did nothing.

## What changed

- `webr` is a real, exact-pinned dependency of `apps/web` (`"webr": "0.6.0"`, matching this file's existing exact-pin convention for `ai`/`@ai-sdk/openai`).
- [`scripts/copy-webr-assets.mjs`](../../apps/web/scripts/copy-webr-assets.mjs) materializes `node_modules/webr/dist/` into `apps/web/src/client/public/webr/` at `predev`/`prebuild` time. Not committed — gitignored, same reasoning as `node_modules/` itself. It walks up from the workspace root to find the hoisted `node_modules/webr/dist` (npm workspaces doesn't guarantee it lands directly under `apps/web/node_modules`).
- `useWebR.ts`'s `computeModuleUrl()` resolves to `${window.location.origin}/webr/webr.js` — a same-origin path served through Vite's public dir in dev, and through the Workers `ASSETS` binding in prod (this app already serves `dist/client` that way).
- `new mod.WebR({ baseUrl: "/webr/" })` — `baseUrl` (not `SW_URL`) points the WASM binary/package downloads at the same self-hosted directory.
- COOP/COEP headers (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`) are set globally in [`server/index.ts`](../../apps/web/src/server/index.ts) (prod/Worker path) and in [`vite.config.ts`](../../apps/web/vite.config.ts)'s `server`/`preview` headers (dev path, since Vite serves pages directly and bypasses the Hono app except for `/api/*`).

## Two real bugs the first self-hosting attempt shipped with

Both were invisible to unit tests (which mock the module) and only surfaced by actually running the self-hosted build in a browser — exactly Cordero's #368 point.

1. **Vite's public-directory import guard.** A *literal* root-relative specifier (`"/webr/webr.mjs"`), even behind `@vite-ignore`, is hard-blocked by Vite dev: "Cannot import non-asset file ... which is inside /public." `@vite-ignore` suppresses Vite's dependency-crawl/bundling, not this specific import-analysis check. Fix: make the specifier a genuinely runtime-computed value (`computeModuleUrl()`, built from `window.location.origin` at call time) rather than a module-level string constant — an absolute URL reads as external to that check and passes through untouched, the same reason the old CDN string never tripped it either.

2. **`webr.mjs` vs. `webr.js`.** `webr`'s package.json exposes three loading builds via `exports` conditions: `import` (`dist/webr.mjs`), `require` (`dist/webr.cjs`), and `browser` (`dist/webr.js`). `webr.mjs` is a dual Node/browser build whose top-level static imports include Node's own `module`/`url`/`path` built-ins (for its Node runtime support) — a browser's native ES module loader cannot resolve these at all ("Failed to resolve module specifier 'module'"), immediately, before WebR does anything else. `webr.js` is the package's dedicated `browser` export condition: those same built-ins are pre-shimmed at build time instead of imported, and it's a genuine ES module. Loading `webr.mjs` here would have shipped broken to every real browser despite passing every mocked test.

## `ChannelType` / no service worker

Confirmed directly against the installed package (`node_modules/webr/dist/webR/webr-main.d.ts`, `node_modules/webr/dist/webr.js`): this version's `ChannelType` is `Automatic | SharedArrayBuffer | PostMessage` only — there is no ServiceWorker channel at all (zero occurrences of the string "ServiceWorker" anywhere in the runtime bundle). `channelType` is left at its `Automatic` default: it uses `SharedArrayBuffer` when the page is cross-origin-isolated (the COOP/COEP headers above) and transparently falls back to `PostMessage` otherwise. No service worker registration, same-origin or otherwise, is required for either path — the old code's `SW_URL` option was never a real config field for this version and did nothing either way.

## WorkOS auth and COOP/COEP

`Cross-Origin-Opener-Policy: same-origin` is applied globally, including to the auth routes. This is safe here because the WorkOS flow (`routes/auth.ts`) is redirect-based (`c.redirect`), not popup-based — COOP only affects `window.opener`/popup communication, which this flow never uses. `require-corp` (not the more permissive `credentialless`) is used for COEP since this app doesn't need to embed uncooperative cross-origin resources.

## Live verification

Confirmed against a real, running browser session (not inferred from source, not left to the necessarily-mocked unit tests to catch): `crossOriginIsolated === true`, a same-origin `import()` of `webr.js`, `WebR` construction, `init()`, `evalR("1 + 1") -> 2`, setting `webr::canvas` as the graphics device, a real `Shelter` + `captureR()` round trip capturing `stdout`/`message`/`warning` output, and `shelter.purge()`.

One pre-existing bug this verification surfaced (not introduced by this change, never previously verified live): `install.packages()` fails in this WASM build with "This version of R is not set up to install source packages." This is non-fatal — `useWebR.ts`'s `DEFAULT_PACKAGES` loop already wraps each install attempt in its own `try`/`catch` — but it does mean the default `dplyr`/`ggplot2`/`tidyr` packages likely never actually install, silently. Tracked separately (see the follow-up issue linked from `useWebR.ts`'s own doc comment).

## Why this isn't an automated CI check

The existing suite is Node/jsdom-based (Vitest) with no real browser and no network access to download an ~18MB WASM binary per run — both `useWebR.ts`'s own unit tests and CI intentionally mock the module out (see `useWebR.test.ts`'s own doc comment) rather than exercise the real thing. A genuine same-origin-serving + cross-origin-isolation + WASM-init smoke test would need a real, real-browser-driven CI job (Playwright or similar) pointed at a running dev/preview server, which this repo doesn't have today. Until that exists, this is manually verified per release rather than automated: re-run the live-browser check described above (self-host build, open a section chat, confirm R code actually executes) whenever `webr`'s pinned version changes or this file's loading logic changes.

## Asset size

Confirmed against the real downloaded tarball: 170 files, 46.4 MiB total, largest single file 18 MiB (`R.wasm`). Comfortably inside Cloudflare Workers Static Assets' limits (25 MiB/file, 20k free / 100k paid file count).

## See also

- [dev-api-proxy.md](./dev-api-proxy.md) — the other case where dev-mode Vite and prod-mode Workers need parallel, not identical, plumbing
- `apps/web/src/client/hooks/useWebR.ts` — source, including `computeModuleUrl`'s own doc comment
- `apps/web/scripts/copy-webr-assets.mjs` — asset materialization
