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

/** An R error item's `data` is an R error object (not a plain string) --
 *  r-execution-manager.js awaits its own `.toString()` to get readable
 *  text. Mirrors that: tolerates a sync OR async `toString`, and falls
 *  back to a generic message rather than throwing if neither shape holds. */
async function stringifyErrorData(data: unknown): Promise<string> {
  if (data && typeof (data as { toString?: unknown }).toString === "function") {
    try {
      const maybe = (data as { toString(): unknown }).toString();
      const str = maybe instanceof Promise ? await maybe : maybe;
      if (typeof str === "string" && str.length > 0 && str !== "[object Object]") return str;
    } catch {
      // fall through to the generic message below
    }
  }
  return "An error occurred during R execution";
}

interface ProcessedCapture {
  output: string;
  error: string | null;
  images: ImageBitmap[];
}

/** Turns WebR's raw captureR() result into plain text + an optional error,
 *  matching r-execution-manager.js's displayResults/executeCode exactly:
 *  stdout/stderr lines are joined in the order captured (#28 Pitfall
 *  "Output capture" -- interleaved stdout/stderr/errors must not be
 *  reordered or dropped), an `error` item is captured but does not stop
 *  processing the rest of `output`, and if nothing was printed at all the
 *  last expression's own result value is used as a last resort. */
async function processCapture(captured: WebRCaptureResult): Promise<ProcessedCapture> {
  const lines: string[] = [];
  let errorText: string | null = null;
  for (const item of captured.output ?? []) {
    if (item.type === "stdout" || item.type === "stderr") {
      lines.push(typeof item.data === "string" ? item.data : String(item.data));
    } else if (item.type === "error") {
      errorText = await stringifyErrorData(item.data);
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
          // #28 Pitfall "Execution timeout": verify the instance recovers
          // after a timeout rather than deadlocking subsequent calls --
          // purging here (even when captureR itself never settled) frees
          // whatever R-side objects this shelter already allocated so the
          // NEXT run() starts clean instead of accumulating shelter state.
          try {
            await shelter.purge();
          } catch {
            // Best-effort cleanup; a purge failure must not mask the
            // result already computed above.
          }
        }
      } finally {
        setIsRunning(false);
      }
    },
    [ensureReady],
  );

  return { webRStatus, webRError, isRunning, run };
}
