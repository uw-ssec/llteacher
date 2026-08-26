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

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./api-client";

export interface UseApiResourceOptions<T> {
  /** #358: what to announce while loading, and how to describe the result.
   *
   *  Loading states were silent for screen-reader users: `ViewLoading`
   *  renders plain text with no live region, so a page simply changed under
   *  them with no signal that anything was happening or that it had
   *  finished. Adding `role="status"` to that block would NOT fix it -- an
   *  element inserted into the DOM already containing its text does not
   *  reliably announce, which is the pattern #204 (ACC-028) filed. The fix
   *  is to write into the view's PERMANENTLY-MOUNTED region, which only the
   *  view has, so the hook takes the writer rather than owning one. */
  announce?: (message: string) => void;
  /** Announced when the load starts. */
  loadingMessage?: string;
  /** Announced on success, given the result -- so it can say "24 people
   *  loaded" rather than "loaded", which is the difference between a signal
   *  and a useful one. */
  describeResult?: (result: T) => string;
}

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
  options: UseApiResourceOptions<T> = {},
): ApiResource<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [nonce, setNonce] = useState(0);

  // The caller passes a fresh closure every render; `deps` is what actually
  // decides when to refetch, exactly as useEffect's own contract works.
  const run = useCallback(load, deps);

  // Read through a ref so a caller can pass inline closures for these
  // without the effect re-running on every render -- the announce function
  // is a useCallback in practice, but describeResult rarely is.
  const announcers = useRef(options);
  announcers.current = options;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const { announce, loadingMessage, describeResult } = announcers.current;
    if (announce && loadingMessage) announce(loadingMessage);
    run({ signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setData(result);
        setLoading(false);
        // Announced on completion as well as on start: without it the last
        // thing a screen reader heard is "Loading…", with no signal that the
        // content arrived.
        if (announce && describeResult) announce(describeResult(result));
      })
      .catch((err: unknown) => {
        // The view moved on. Not a failure, and reporting it would flash an
        // error banner during teardown.
        if ((err as Error)?.name === "AbortError" || controller.signal.aborted) return;
        const apiError =
          err instanceof ApiError
            ? err
            : new ApiError("server", "Something went wrong. Please try again.");
        setError(apiError);
        setLoading(false);
        // ViewError renders through AdminNotice, whose error tone carries
        // role="alert" -- but the denied tone deliberately does not (a 403
        // is the page's content, not an interruption), so the polite region
        // is the only channel for that case.
        announce?.(apiError.message);
      });
    return () => controller.abort();
  }, [run, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, loading, error, canRetry: error?.retryable ?? false, reload };
}
