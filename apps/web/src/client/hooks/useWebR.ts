import { useCallback, useState } from "react";

/* --------------------------------------------------------------------------
   useWebR — lazy, singleton WebR (R-in-WASM) lifecycle (#28).

   Django parity: static/js/r-execution-manager.js's RExecutionManager class
   -- dynamic-import the WebR module from the CDN, init once, set
   webr::canvas as the default graphics device (so plots can be captured --
   see useRExecution.ts), install a handful of common packages, and reuse
   the same instance for every subsequent evaluation.

   Singleton, not per-hook-instance state (#28 Pitfall "WebR initialization
   timing"): WebR compiles a ~60MB WASM binary, 5-10s. This app mounts TWO
   independent chat surfaces that could each want R execution (the
   homework-section chat and the tutor rail, #4) -- if each `useWebR()` call
   owned its own instance, having both mounted (or even just remounting one,
   e.g. switching sections) would re-pay that cost and end up with two
   WebR instances silently diverging (installed packages, R global state).
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

const WEBR_MODULE_URL = "https://webr.r-wasm.org/latest/webr.mjs";
const WEBR_SW_URL = "https://webr.r-wasm.org/latest/";

/** Installed once at init, matching r-execution-manager.js's own list --
 *  common enough that most section R exercises need at least one, and
 *  installing upfront avoids a multi-second `install.packages()` stall the
 *  first time a student's own code happens to `library(ggplot2)`. */
const DEFAULT_PACKAGES = ["ggplot2", "dplyr", "tidyr"];

/* Minimal shape of the webr.mjs module/instance this app actually calls --
   not the full @r-wasm/webr type surface (that package isn't a build
   dependency; the real module is loaded at runtime from the CDN above),
   just what this hook's init sequence and useRExecution.ts's evaluation
   path use. */
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
  Shelter: new () => WebRShelter;
}
interface WebRModule {
  WebR: new (config?: { SW_URL?: string }) => WebRInstance;
}

let webRInstance: WebRInstance | null = null;
let initPromise: Promise<WebRInstance> | null = null;
let initError: string | null = null;

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function doInit(): Promise<WebRInstance> {
  // @vite-ignore -- a genuine runtime CDN import, not a bundleable local
  // module; Vite must not try to resolve/analyze this specifier at build
  // time (see WEBR_MODULE_URL's own doc comment).
  const mod = (await import(/* @vite-ignore */ WEBR_MODULE_URL)) as WebRModule;
  const webR = new mod.WebR({ SW_URL: WEBR_SW_URL });
  await webR.init();
  // webr::canvas as the default graphics device -- Django parity, and the
  // one setting that makes plot capture (useRExecution.ts) possible at all.
  await webR.evalRVoid("options(device=webr::canvas)");
  for (const pkg of DEFAULT_PACKAGES) {
    try {
      await webR.evalR(`if (!require(${pkg}, quietly = TRUE)) { install.packages("${pkg}", quiet = TRUE) }`);
    } catch {
      // Best-effort, matching r-execution-manager.js's installCommonPackages
      // -- WebR is still usable without any one of these; a single package
      // failing to install (e.g. this CDN mirror not carrying it) must not
      // fail init for the whole app.
    }
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

  const ensureReady = useCallback(() => {
    setStatus((s) => (s === "ready" ? s : "loading"));
    return ensureInit()
      .then((webR) => {
        setStatus("ready");
        setError(undefined);
        return webR;
      })
      .catch((err: unknown) => {
        const message = describeError(err);
        setStatus("error");
        setError(message);
        throw err;
      });
  }, []);

  return { status, error, ensureReady };
}
