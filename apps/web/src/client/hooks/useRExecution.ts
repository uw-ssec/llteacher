import { useCallback, useState } from "react";
import type { RCodeResult } from "@llteacher/ui";
import { useWebR, type WebRCaptureResult, type WebRStatus } from "./useWebR";

/* --------------------------------------------------------------------------
   useRExecution — runs R code against the shared WebR singleton (#28).

   Separate from useWebR (lifecycle/init only) so each hook has one job:
   useWebR owns "is R ready to use", this hook owns "run this code and turn
   whatever WebR captured into an RCodeResult" -- output/error extraction,
   the 30s execution timeout, and plot capture.

   Django parity: static/js/r-execution-manager.js's executeCode -- a
   Shelter + captureR(code), text output assembled from stdout/stderr
   items (falling back to the last-expression result's own toString() when
   nothing was printed), an `error` item flagged separately, and
   shelter.purge() afterward to release whatever R-side objects this call
   allocated.
   -------------------------------------------------------------------------- */

/** #28 Pitfall "Execution timeout": R can hang (infinite loops, heavy
 *  computation) with no way for this app to forcibly cancel an in-flight
 *  WebR evaluation (no real cancellation API is exposed to the browser
 *  side). This bounds how long THIS call waits before reporting a timeout
 *  error back to the caller -- it does not, and cannot, kill the
 *  underlying R evaluation. */
export const R_EXECUTION_TIMEOUT_MS = 30_000;

const TIMEOUT_SENTINEL = Symbol("r-execution-timeout");

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(TIMEOUT_SENTINEL), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** An `error`/`message`/`warning` captured item's `data` is an R condition
 *  object (an RObject proxy, not a plain string) -- r-execution-manager.js
 *  awaits its own `.toString()` on the `error` case to get readable text;
 *  this generalizes that to all three condition types (see processCapture
 *  below), which share the same RObject-proxy shape. Tolerates a sync OR
 *  async `toString`, and falls back to `fallback` rather than throwing if
 *  neither shape holds. */
async function stringifyConditionData(data: unknown, fallback: string): Promise<string> {
  if (data && typeof (data as { toString?: unknown }).toString === "function") {
    try {
      const maybe = (data as { toString(): unknown }).toString();
      const str = maybe instanceof Promise ? await maybe : maybe;
      if (typeof str === "string" && str.length > 0 && str !== "[object Object]") return str;
    } catch {
      // fall through to the fallback below
    }
  }
  return fallback;
}

interface ProcessedCapture {
  output: string;
  error: string | null;
  images: ImageBitmap[];
}

/** Turns WebR's raw captureR() result into plain text + an optional error,
 *  matching r-execution-manager.js's displayResults/executeCode exactly:
 *  stdout/stderr/message/warning lines are joined in the order captured
 *  (#28 Pitfall "Output capture" -- interleaved output must not be
 *  reordered or dropped), an `error` item is captured but does not stop
 *  processing the rest of `output`, and if nothing was printed at all the
 *  last expression's own result value is used as a last resort.
 *
 *  Code-review follow-up (#28): captureR()'s own docs (docs.r-wasm.org/
 *  webr/latest/evaluating.html) list FIVE output item types, not three --
 *  `message`/`warning` (from R's own message()/warning()) carry an
 *  RObject-proxy `data`, same shape as `error`'s, and were previously
 *  silently dropped (matched by neither the stdout/stderr branch, which
 *  only handles a plain string, nor the error branch). Real, not
 *  contrived: useWebR.ts installs dplyr/tidyr by default, and dplyr's
 *  summarise() alone emits a message() on every grouped call. Treated as
 *  OUTPUT (appended to `lines`, not surfaced via `errorText`) -- R itself
 *  treats message()/warning() as informational conditions that don't stop
 *  execution, unlike a stop()-raised error, so RCodeResult.status stays
 *  "success" for a run that only ever produced these. */
async function processCapture(captured: WebRCaptureResult): Promise<ProcessedCapture> {
  const lines: string[] = [];
  let errorText: string | null = null;
  for (const item of captured.output ?? []) {
    if (item.type === "stdout" || item.type === "stderr") {
      lines.push(typeof item.data === "string" ? item.data : String(item.data));
    } else if (item.type === "message" || item.type === "warning") {
      const fallback = item.type === "warning" ? "A warning occurred during execution" : "An R message occurred during execution";
      lines.push(await stringifyConditionData(item.data, fallback));
    } else if (item.type === "error") {
      errorText = await stringifyConditionData(item.data, "An error occurred during R execution");
    }
  }
  let output = lines.join("\n");
  if (!output.trim() && !errorText && captured.result) {
    try {
      const resultStr = await captured.result.toString();
      if (resultStr && resultStr.trim() && resultStr !== "NULL") output = resultStr;
    } catch {
      // Ignore conversion errors, matches r-execution-manager.js.
    }
  }
  const images = (captured.images ?? []) as ImageBitmap[];
  return { output, error: errorText, images };
}

export interface UseRExecutionResult {
  /** Passed through from useWebR -- lets a caller (e.g. CodeExecution's Run
   *  button) show a loading/error state without needing its own useWebR(). */
  webRStatus: WebRStatus;
  webRError?: string;
  isRunning: boolean;
  /** Executes R code against the shared WebR singleton, lazily
   *  initializing it on first call. Never rejects: every failure mode
   *  (WebR unavailable, a 30s timeout, an R-level error) resolves to
   *  `RCodeResult.status: "error"` instead, so callers never need their
   *  own try/catch around this -- matching #28's "graceful degradation...
   *  chat still usable" requirement. */
  run: (code: string) => Promise<RCodeResult>;
}

export function useRExecution(): UseRExecutionResult {
  const { status: webRStatus, error: webRError, ensureReady } = useWebR();
  const [isRunning, setIsRunning] = useState(false);

  const run = useCallback(
    async (code: string): Promise<RCodeResult> => {
      const startedAt = Date.now();
      setIsRunning(true);
      try {
        let webR;
        try {
          webR = await ensureReady();
        } catch (err) {
          return {
            status: "error",
            error: `R execution isn't available right now: ${describeError(err)}`,
            executionTimeMs: Date.now() - startedAt,
          };
        }

        // Matches r-execution-manager.js's own `await new this.webR.Shelter()`.
        const shelter = await new webR.Shelter();
        try {
          const captured = await withTimeout(shelter.captureR(code), R_EXECUTION_TIMEOUT_MS);
          const { output, error, images } = await processCapture(captured);
          const executionTimeMs = Date.now() - startedAt;
          if (error) {
            return { status: "error", error, output: output || undefined, executionTimeMs, images: images.length ? images : undefined };
          }
          return { status: "success", output: output || undefined, executionTimeMs, images: images.length ? images : undefined };
        } catch (err) {
          const executionTimeMs = Date.now() - startedAt;
          if (err === TIMEOUT_SENTINEL) {
            return {
              status: "error",
              error: `Timeout: code execution exceeded ${R_EXECUTION_TIMEOUT_MS / 1000}s`,
              executionTimeMs,
            };
          }
          return { status: "error", error: describeError(err), executionTimeMs };
        } finally {
          // #28 Pitfall "Execution timeout": fire-and-forget, NOT awaited,
          // and it must stay that way. WebR's worker is single-threaded --
          // while a spinning evaluation (e.g. `while (TRUE) {}`) is still
          // occupying it, a purge message queued behind that same worker
          // never gets processed until the loop somehow stops, which for a
          // genuine infinite loop is never. Awaiting `shelter.purge()` here
          // would therefore mean run() itself can never settle on the
          // timeout path: the `{status:"error", error:"Timeout: ..."}`
          // object built in the catch block above would already exist, but
          // the caller would never receive it, isRunning would never go
          // back to false, and the UI would stay on "Running…" forever --
          // exactly the hang the 30s timeout exists to prevent. Not
          // awaiting lets run() settle at the 30s mark regardless of
          // whether the underlying worker is still occupied.
          //
          // Honest limitation, not full recovery: this does NOT interrupt a
          // genuinely hung evaluation. The webr.mjs module here is loaded
          // at runtime from a CDN (WEBR_MODULE_URL, useWebR.ts) rather than
          // a pinned npm dependency this codebase can inspect/type for a
          // real interrupt API, so implementing true cancellation is out of
          // scope for this fix. If the worker really is stuck on an
          // infinite loop, this purge call (and every future call sharing
          // the same WebR instance) queues behind it and may never
          // complete -- the NEXT run() call still starts a fresh Shelter
          // (see the call site above), so a stuck shelter's own purge
          // failing to ever run does not, by itself, block a later run()
          // from returning; it only means this shelter's R-side objects may
          // never actually get freed.
          // WebRShelter.purge()'s return type is `unknown` (useWebR.ts's own
          // minimal type surface for the CDN-loaded module) -- wrapped in
          // Promise.resolve() so `.catch` is available regardless of
          // whether the real call returns a promise or not.
          void Promise.resolve(shelter.purge()).catch(() => {
            // Best-effort cleanup; a purge failure (or a purge that never
            // resolves at all) must not mask the result already computed
            // above, and must not keep run() itself from settling.
          });
        }
      } finally {
        setIsRunning(false);
      }
    },
    [ensureReady],
  );

  return { webRStatus, webRError, isRunning, run };
}
