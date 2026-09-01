import { useCallback, useState } from "react";

/* --------------------------------------------------------------------------
   useWebR — lazy, singleton WebR (R-in-WASM) lifecycle (#28).

   Django parity: static/js/r-execution-manager.js's RExecutionManager class
   -- dynamic-import the WebR module, init once, set webr::canvas as the
   default graphics device (so plots can be captured -- see
   useRExecution.ts), install a handful of common packages, and reuse the
   same instance for every subsequent evaluation.

   #368/#369 (blocking): originally loaded from
   https://webr.r-wasm.org/latest/webr.mjs -- a genuinely untested path
   (every test mocks the module out) with two real problems: `latest` means
   what code runs in this authenticated origin can change with no repo
   change, no review, no reproducible build; and the module was loaded
   cross-origin with no self-hosting story, unverified against a real
   browser. Fixed by pinning `webr` as a real, exact-versioned dependency
   (package.json) and self-hosting its release assets -- see
   scripts/copy-webr-assets.mjs, which materializes them into Vite's public
   dir at dev/build time (not committed, same reasoning as node_modules/
   itself) -- so computeModuleUrl() below now resolves to a same-origin path
   served through the app's own ASSETS binding, not a third-party CDN.

   `baseUrl` (not the `SW_URL` option the old code passed, which isn't a
   real WebROptions field in this pinned version -- see below) points the
   R WASM binary/package downloads at the same self-hosted directory.
   Verified directly against the installed package (node_modules/webr/dist/
   webR/webr-main.d.ts, node_modules/webr/dist/webr.mjs): this version's
   `ChannelType` is `Automatic | SharedArrayBuffer | PostMessage` only --
   there is no ServiceWorker channel at all (confirmed: zero occurrences of
   the string "ServiceWorker" anywhere in the actual runtime bundle), so the
   old code's `SW_URL` option was never a real webR config field for this
   version and did nothing either way. `channelType` is left at its
   `Automatic` default: it uses SharedArrayBuffer when the page is
   cross-origin-isolated (see server/index.ts's COOP/COEP middleware) and
   transparently falls back to PostMessage otherwise -- no service worker,
   no same-origin registration step, required for either path.

   All of the above was verified against a real, running browser session
   against this self-hosted build, not inferred from source or left to the
   (necessarily mocked) unit tests below to catch -- crossOriginIsolated
   true, a same-origin import(), WebR construction, init(), and a real
   evalR("1 + 1") -> 2 round trip. See computeModuleUrl's own doc comment
   for the one genuine bug that verification caught (webr.mjs vs. webr.js).

   Singleton, not per-hook-instance state (#28 Pitfall "WebR initialization
   timing"): WebR compiles a ~18MB WASM binary (R.wasm) plus supporting
   package data, several seconds. This app mounts TWO independent chat
   surfaces that could each want R execution (the homework-section chat and
   the tutor rail, #4) -- if each `useWebR()` call owned its own instance,
   having both mounted (or even just remounting one, e.g. switching
   sections) would re-pay that cost and end up with two WebR instances
   silently diverging (installed packages, R global state).
   `webRInstance`/`initPromise` below are module-level so every hook
   instance across the whole app shares exactly one. `initPromise` itself is
   the race guard: a second caller arriving while the first is still loading
   awaits the SAME promise instead of kicking off a second init (#28's own
   "Client initialization race" testing requirement).

   Lazy: init is never triggered by this hook itself (no init-on-mount
   effect) -- only `ensureReady()` starts it, and only the first caller
   actually pays for it (#28 Pitfall: "Lazy init on first code execution
   request, not on page load").
   -------------------------------------------------------------------------- */

/** Same-origin path served by Vite's public dir (dev) / the Workers ASSETS
 *  binding (prod) -- see scripts/copy-webr-assets.mjs and this file's own
 *  header comment. Kept as a runtime specifier (not a static `import
 *  "webr"`) for the same reason the old CDN version was: `@vite-ignore`
 *  below tells Vite not to try to bundle/analyze the ~18MB WASM binary this
 *  resolves to, and to load it from the public dir at request time like any
 *  other static asset instead.
 *
 *  Genuinely a live browser bug the first version of this fix shipped with,
 *  caught only by running it (Cordero's own point about #368): a *literal*
 *  root-relative specifier (`"/webr/webr.mjs"`) still gets caught by Vite
 *  dev's own import-analysis, which hard-blocks `import()` of anything it
 *  can statically resolve to a file under `public/` -- "Cannot import
 *  non-asset file ... which is inside /public", `@vite-ignore` does not
 *  suppress this specific check, only Vite's dependency-crawl/bundling. An
 *  absolute URL (built from `location.origin` at call time, not a module-
 *  level string constant) reads as external to that same check and passes
 *  through untouched -- exactly why the old CDN version, a literal
 *  `https://...` string, never tripped it either. computeModuleUrl is a
 *  function, not a constant, so the specifier genuinely cannot be resolved
 *  at transform time even by a lexer that traces simple const references. */
function computeModuleUrl(): string {
  // webr.js, not webr.mjs -- verified live (a real browser session, not
  // inferred from source): webr.mjs is a dual Node/browser build whose
  // top-level static imports include Node's own "module"/"url"/"path"
  // built-ins (for its Node.js runtime support), which a browser's native
  // ES module loader cannot resolve at all -- "Failed to resolve module
  // specifier 'module'", immediately, before webR does anything else.
  // webr.js is the package's own dedicated "browser" export condition
  // (package.json's exports["."].browser) -- those same built-ins are
  // pre-shimmed at build time instead of imported, and it's a genuine ES
  // module (real `export { WebR, ... }`, confirmed by reading the file).
  // Loading webr.mjs here would have shipped broken to every real browser
  // despite passing every mocked test -- exactly Cordero's #368 point.
  return `${window.location.origin}/webr/webr.js`;
}
const WEBR_BASE_URL = "/webr/";

/** Installed once at init, matching r-execution-manager.js's own list --
 *  common enough that most section R exercises need at least one, and
 *  installing upfront avoids a multi-second install stall the first time a
 *  student's own code happens to `library(ggplot2)`.
 *
 *  #374: these used to be installed by evaluating R's own
 *  `install.packages()`, which fails outright on this build -- "This
 *  version of R is not set up to install source packages". That is not a
 *  misconfiguration to work around, it is correct: R's stock installer
 *  builds packages from source, and there is no C/C++/Fortran toolchain
 *  inside the WASM R process to build them with. webR's answer is a
 *  separate repository of packages *pre-compiled to WASM* and its own
 *  installer that fetches them -- `WebR#installPackages` (JS) /
 *  `webr::install()` (R), which resolves dependencies and mounts each
 *  package as an Emscripten filesystem image rather than compiling
 *  anything. Verified against the pinned repo before switching: all three
 *  are present as real WASM binaries at repoUrl's contrib/4.6 index
 *  (R_VERSION 4.6.0 for webr@0.6.0) -- ggplot2 4.0.3, dplyr 1.2.1,
 *  tidyr 1.3.2 -- and it serves `access-control-allow-origin: *`, which is
 *  what lets these fetches succeed under the COEP `require-corp` header
 *  server/index.ts sets on this origin. */
const DEFAULT_PACKAGES = ["ggplot2", "dplyr", "tidyr"];

/** Where the WASM-compiled packages come from. Deliberately left at webR's
 *  own default (`https://repo.r-wasm.org`) rather than self-hosted like the
 *  runtime itself is: #369's objection was to third-party *JavaScript*
 *  executing in this authenticated origin, and this is a different risk
 *  class -- R packages fetched as data and run inside the sandboxed WASM R
 *  process, never in the page's JS realm. The full mirror is also far too
 *  large to vendor (the contrib index alone is ~4.7MB; the packages behind
 *  it are tens of GB). Named here rather than left implicit so the tradeoff
 *  is visible, and so pointing it at a mirror later is a one-line change. */
const WEBR_REPO_URL = "https://repo.r-wasm.org";

/* Minimal shape of the webr.mjs module/instance this app actually calls --
   not the full WebROptions/WebR type surface `webr`'s own .d.ts exports
   (see node_modules/webr/dist/webR/webr-main.d.ts for the real, complete
   one), just what this hook's init sequence and useRExecution.ts's
   evaluation path use. Loaded via a runtime specifier (@vite-ignore below),
   not a static `import type` from the package, so this stays a hand
   subset by design, not a drift risk against the real types -- `baseUrl`
   below is spelled exactly as WebROptions declares it. */
export interface WebRCaptureOutputItem {
  type: string;
  data: unknown;
}
export interface WebRCaptureResult {
  output: WebRCaptureOutputItem[];
  images?: unknown[];
  result?: { toString(): Promise<string> } | null;
}
export interface WebRShelter {
  captureR(code: string): Promise<WebRCaptureResult>;
  purge(): unknown;
}
export interface WebRInstance {
  init(): Promise<void>;
  evalRVoid(code: string): Promise<void>;
  evalR(code: string): Promise<unknown>;
  /** webR's WASM-binary package installer -- see DEFAULT_PACKAGES (#374).
   *  Spelled exactly as WebR declares it (node_modules/webr/dist/webR/
   *  webr-main.d.ts), including the `repos`/`quiet`/`mount` option names. */
  installPackages(packages: string | string[], options?: { repos?: string | string[]; quiet?: boolean; mount?: boolean }): Promise<void>;
  /** Preferred over `evalR` for a plain predicate: webR unwraps the R
   *  logical to a JS boolean and disposes the underlying R object itself,
   *  so the caller neither guesses at the RObject proxy's shape nor leaks a
   *  reference into the shelter on every call. */
  evalRBoolean(code: string): Promise<boolean>;
  Shelter: new () => WebRShelter;
}
interface WebRModule {
  WebR: new (config?: { baseUrl?: string }) => WebRInstance;
}

let webRInstance: WebRInstance | null = null;
let initPromise: Promise<WebRInstance> | null = null;
let initError: string | null = null;
/** Which of DEFAULT_PACKAGES init could not make available, surfaced on the
 *  hook so a caller can tell a student "dplyr isn't available here" instead
 *  of letting `library(dplyr)` fail with a bare R error (#374). */
let missingPackages: string[] = [];

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Asks R itself which of DEFAULT_PACKAGES actually resolve, rather than
 *  trusting the installer's return. This is the check whose absence made
 *  #374 invisible for a whole release: `requireNamespace` is the same
 *  question `library()` will ask when a student's code runs, so a package
 *  that passes here is genuinely usable and one that doesn't is genuinely
 *  not. Never throws -- a broken probe must not fail init. */
async function findMissingPackages(webR: WebRInstance): Promise<string[]> {
  const missing: string[] = [];
  for (const pkg of DEFAULT_PACKAGES) {
    try {
      const ok = await webR.evalRBoolean(`isTRUE(requireNamespace("${pkg}", quietly = TRUE))`);
      if (!ok) missing.push(pkg);
    } catch {
      missing.push(pkg);
    }
  }
  return missing;
}

async function doInit(): Promise<WebRInstance> {
  // @vite-ignore -- a same-origin runtime import of a ~18MB WASM-backed
  // module, not a bundleable local module; Vite must not try to
  // resolve/analyze this specifier at build time (see computeModuleUrl's own
  // doc comment for why it's a function call here, not a module-level
  // string constant).
  const mod = (await import(/* @vite-ignore */ computeModuleUrl())) as WebRModule;
  const webR = new mod.WebR({ baseUrl: WEBR_BASE_URL });
  await webR.init();
  // webr::canvas as the default graphics device -- Django parity, and the
  // one setting that makes plot capture (useRExecution.ts) possible at all.
  await webR.evalRVoid("options(device=webr::canvas)");
  // One call for the whole list, not one per package: webR resolves the
  // shared dependency graph (all three pull in rlang/vctrs/cli/glue/...)
  // once, instead of re-walking it three times.
  //
  // Best-effort, matching r-execution-manager.js's installCommonPackages --
  // WebR is still usable without any of these, and a repo outage must not
  // leave the whole R feature dead. But #374's real lesson is that
  // best-effort was also *silent*: every install had been failing since the
  // feature shipped and nothing said so. So the outcome is checked and
  // recorded either way, and anything missing is reported once.
  try {
    await webR.installPackages(DEFAULT_PACKAGES, { repos: WEBR_REPO_URL, quiet: true });
  } catch (err: unknown) {
    console.warn(`[webr] package install failed: ${describeError(err)}`);
  }
  missingPackages = await findMissingPackages(webR);
  if (missingPackages.length > 0) {
    console.warn(
      `[webr] these packages are NOT available to student code: ${missingPackages.join(", ")} -- library() will fail for them (#374)`,
    );
  }
  return webR;
}

/** Kicks off (or reuses) the module-level singleton init -- see this file's
 *  own doc comment for the race-safety argument. Exported only for this
 *  hook's own use; components should go through `useWebR().ensureReady`. */
function ensureInit(): Promise<WebRInstance> {
  if (webRInstance) return Promise.resolve(webRInstance);
  if (!initPromise) {
    initPromise = doInit()
      .then((webR) => {
        webRInstance = webR;
        return webR;
      })
      .catch((err: unknown) => {
        initError = describeError(err);
        // A failed init taught us nothing about package availability -- do
        // not leave a stale verdict from a previous attempt behind it.
        missingPackages = [];
        // Un-pin the promise so a later ensureReady() call retries instead
        // of replaying the same rejection forever -- a transient CDN blip
        // shouldn't be this app's permanent failure state.
        initPromise = null;
        throw err;
      });
  }
  return initPromise;
}

export type WebRStatus = "idle" | "loading" | "ready" | "error";

export interface UseWebRResult {
  status: WebRStatus;
  error?: string;
  /** Any of DEFAULT_PACKAGES that init could not make available, verified
   *  against R itself rather than assumed (#374). Empty until init resolves
   *  -- callers should read it only once `status === "ready"`. Lets a
   *  surface warn the student up front instead of leaving them to decode a
   *  bare `there is no package called 'dplyr'` from their own code. */
  missingPackages: string[];
  /** Lazily triggers init on first call and resolves once the shared
   *  singleton is ready. Safe to call again once ready (resolves
   *  immediately with the same instance) or concurrently from multiple
   *  hook instances (all callers await the same in-flight init promise). */
  ensureReady: () => Promise<WebRInstance>;
}

export function useWebR(): UseWebRResult {
  // Reflects the module-level singleton's CURRENT state at mount time --
  // if another component already finished (or failed) init before this
  // hook instance ever rendered, this hook starts already "ready"/"error"
  // instead of showing a misleading "idle" until its own ensureReady() is
  // called.
  const [status, setStatus] = useState<WebRStatus>(webRInstance ? "ready" : initError ? "error" : "idle");
  const [error, setError] = useState<string | undefined>(initError ?? undefined);
  const [missing, setMissing] = useState<string[]>(missingPackages);

  const ensureReady = useCallback(() => {
    setStatus((s) => (s === "ready" ? s : "loading"));
    return ensureInit()
      .then((webR) => {
        setStatus("ready");
        setError(undefined);
        setMissing(missingPackages);
        return webR;
      })
      .catch((err: unknown) => {
        const message = describeError(err);
        setStatus("error");
        setError(message);
        setMissing([]);
        throw err;
      });
  }, []);

  return { status, error, missingPackages: missing, ensureReady };
}
