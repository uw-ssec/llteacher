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

Confirmed against a real, running browser session (not inferred from source, not left to the necessarily-mocked unit tests to catch): a same-origin `import()` of `webr.js`, `WebR` construction, `init()`, `evalR("1 + 1") -> 2`, setting `webr::canvas` as the graphics device, a real `Shelter` + `captureR()` round trip capturing `stdout`/`message`/`warning` output, and `shelter.purge()`.

Re-run for the #374 fix, this time driving the **real `useWebR`/`useRExecution` hooks** rather than a hand-written replica of their init sequence (mount them in a throwaway component against the dev server; the harness is not committed). Confirmed end to end: `status: "ready"`, `missingPackages: []`, all three packages installing in ~3.5s, then a single student-style run producing correct `dplyr` `group_by`/`summarise` output, a correct `tidyr::pivot_wider`, one captured `ggplot2` image, readable `message()`/`warning()` text, and a following `stop()` still resolving to `status: "error"`. Both channel paths are exercised in practice — this run was **not** cross-origin-isolated and took webR's `PostMessage` fallback, which is itself worth knowing works.

## Package installation (#374)

`DEFAULT_PACKAGES` (`ggplot2`, `dplyr`, `tidyr`) were originally installed by evaluating R's own `install.packages()`. Live verification showed that fails outright on this build:

```
Error in `install.packages("dplyr", quiet = TRUE)`: This version of R is not set up to install source packages
```

That is not a misconfiguration to work around — it is correct. R's stock installer builds packages from source, and there is no C/C++/Fortran toolchain inside the WASM R process to build them with. Because the old loop caught each failure per-package, this was **silent**: the feature shipped with none of the three packages ever available to students, and nothing said so.

**The fix.** webR maintains a separate repository of packages *pre-compiled to WASM* and its own installer to fetch them — `WebR#installPackages` (JS) / `webr::install()` (R). It resolves dependencies and mounts each package as an Emscripten filesystem image rather than compiling anything:

```ts
await webR.installPackages(DEFAULT_PACKAGES, { repos: WEBR_REPO_URL, quiet: true });
```

Verified live: all three install in ~3.5s and `library()` works for each. Versions come from the repo's `contrib/4.6` index (`R_VERSION` is 4.6.0 for `webr@0.6.0`) — ggplot2 4.0.3, dplyr 1.2.1, tidyr 1.3.2 at time of writing.

**Why the repo is not self-hosted.** `WEBR_REPO_URL` is left at webR's own default, `https://repo.r-wasm.org`, unlike the runtime itself. #369's objection was to third-party *JavaScript* executing in this authenticated origin; this is a different risk class — R packages fetched as data and run inside the sandboxed WASM R process, never in the page's JS realm. The mirror is also far too large to vendor (the `contrib` index alone is ~4.7MB; the packages behind it are orders of magnitude larger). It serves `access-control-allow-origin: *`, which is what lets these fetches succeed under the `require-corp` COEP header above. The constant is named rather than left implicit so pointing it at a mirror later is a one-line change.

**No longer silent.** After installing, init asks R itself which packages actually resolve (`requireNamespace`, the same question `library()` will ask) and exposes the answer as `useWebR().missingPackages`, logging a warning for anything missing. A repo outage still degrades gracefully — R stays usable — but it can no longer degrade *invisibly*, which was the actual defect behind #374.

## Rendering R conditions (`message()` / `warning()`)

A captured `message`/`warning`/`error` item's `data` is an RObject **proxy** over an R list, verified live to carry exactly `names() === ["message", "call"]`. Two traps:

- The proxy's `toString()` resolves to a *type description* — literally `"[object RObject:list]"` — not the message text. It is non-empty and isn't `"[object Object]"`, so a naive truthy-and-not-`[object Object]` guard accepts it as real content.
- `toJs()` is not an escape hatch: it throws `"This R object cannot be converted to JS"`, because the sibling `call` element is an R language object with no JS equivalent.

The readable text is the `message` element: `await data.get("message")`, then `toString()` on that (and strip the trailing newline R appends). `useRExecution.ts`'s `stringifyConditionData` does this, falling back to the proxy's own `toString()` and then to a generic label.

This was latent until #374 was fixed. With the default packages finally installing, every `library()` call emits its attach messages for the first time, so what used to be a rare path (a student's own `message()`/`warning()`) is now on every run — the first live run after the #374 fix printed three `[object RObject:list]` lines above the student's output. Unit-test stubs of the form `{ toString: async () => "..." }` pass either way, which is exactly why this survived: the tests modelled a shape the real runtime never produces. The regression tests now model the real proxy shape instead.

## Upgrading the pinned version

1. Bump the exact version in `apps/web/package.json`'s `webr` dependency, `npm install`.
2. `npm run copy-webr-assets --workspace=apps/web` (or just `npm run dev`/`build`, which run it automatically) to materialize the new build's assets locally.
3. Diff `node_modules/webr/dist/webR/webr-main.d.ts` against the notes in this file — `ChannelType`, `WebROptions` fields (`baseUrl` in particular), and the `browser`/`import`/`require` export split have all changed across webR releases before and directly determine whether `computeModuleUrl()` and the `baseUrl` option below still need the same values.
4. Re-run the live-browser verification described below against the new version before merging.

## Why this isn't an automated CI check

The existing suite is Node/jsdom-based (Vitest) with no real browser and no network access to download an ~18MB WASM binary per run — both `useWebR.ts`'s own unit tests and CI intentionally mock the module out (see `useWebR.test.ts`'s own doc comment) rather than exercise the real thing. A genuine same-origin-serving + cross-origin-isolation + WASM-init smoke test would need a real, real-browser-driven CI job (Playwright or similar) pointed at a running dev/preview server, which this repo doesn't have today. Until that exists, this is manually verified per release rather than automated: re-run the live-browser check described above (self-host build, open a section chat, confirm R code actually executes) whenever `webr`'s pinned version changes or this file's loading logic changes.

## Asset size

Confirmed against the real downloaded tarball: 170 files, 46.4 MiB total, largest single file 18 MiB (`R.wasm`). Comfortably inside Cloudflare Workers Static Assets' limits (25 MiB/file, 20k free / 100k paid file count).

## See also

- [dev-api-proxy.md](./dev-api-proxy.md) — the other case where dev-mode Vite and prod-mode Workers need parallel, not identical, plumbing
- `apps/web/src/client/hooks/useWebR.ts` — source, including `computeModuleUrl`'s own doc comment
- `apps/web/scripts/copy-webr-assets.mjs` — asset materialization
