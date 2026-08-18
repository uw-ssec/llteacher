/* --------------------------------------------------------------------------
   useApiResource — one load lifecycle for every console view (#33).

   #33 asks for "loading/error/empty states for each view". Written per view
   that becomes eight subtly different implementations of the same four
   states, which is how the console ended up with #191's defect in one view
   and a Retry button in its sibling. This is that lifecycle written once.

   What it owns:

     · The AbortController. One per load, aborted by the effect's own
       cleanup, so a view that unmounts mid-flight cancels the request
       rather than settling and discarding the result (the #202/MNT-032
       lesson).
     · The abort-is-not-an-error rule. A cancelled load never sets state, so
       nothing flashes a failure on the way out.
     · The retry decision. `ApiError.retryable` already answers "is Try again
       honest"; this exposes it so no view has to re-derive it from a status
       code.
     · Refetch. Mutating views need to reload after a write, and a nonce is
       the mechanism that does not require lifting the request into the
       caller.

   What it deliberately does NOT own: caching, deduplication, or a global
   store. See the note at the top of api-client.ts -- a console whose job is
   showing an instructor the roster they are editing wants a fresh read.
   -------------------------------------------------------------------------- */

import { useCallback, useEffect, useState } from "react";
import { ApiError } from "./api-client";

export interface ApiResource<T> {
  data: T | null;
  loading: boolean;
  error: ApiError | null;
  /** True only when retrying could plausibly work. A view offers its Try
   *  again button on this, never on `error !== null` -- a button that can
   *  never succeed reads as a broken console (#191). */
  canRetry: boolean;
  reload: () => void;
}

export function useApiResource<T>(
  load: (opts: { signal: AbortSignal | null }) => Promise<T>,
  deps: readonly unknown[],
): ApiResource<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [nonce, setNonce] = useState(0);

  // The caller passes a fresh closure every render; `deps` is what actually
  // decides when to refetch, exactly as useEffect's own contract works.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(load, deps);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    run({ signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setData(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        // The view moved on. Not a failure, and reporting it would flash an
        // error banner during teardown.
        if ((err as Error)?.name === "AbortError" || controller.signal.aborted) return;
        setError(
          err instanceof ApiError
            ? err
            : new ApiError("server", "Something went wrong. Please try again."),
        );
        setLoading(false);
      });
    return () => controller.abort();
  }, [run, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, loading, error, canRetry: error?.retryable ?? false, reload };
}
