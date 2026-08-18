/* --------------------------------------------------------------------------
   abortAfter — a fetch signal that gives up after `ms`, and also follows a
   parent (component-lifecycle) signal.

   #172 audit (CMP-010, REL-011). Two problems this exists to solve:

   1. `AbortSignal.timeout()` is the obvious way to write this and it is the
      wrong one here. apps/admin declares no `build.target` and no
      `browserslist`, so Vite falls back to its default target and nothing in
      the repo states a floor. `AbortSignal.timeout` is newer than that
      unstated floor on every engine, and it is evaluated as a *function
      argument* -- so on an engine without it the TypeError is thrown before
      `fetch` is ever called, escaping the promise chain rather than landing
      in `.catch`. With no error boundary above these views, React 19
      unmounts the tree and the console renders blank. Every other fetch in
      apps/admin predates this and uses no signal at all, so this was a new
      pattern introduced with no support statement behind it.

   2. `AbortSignal.any()` -- the natural way to combine a timeout with an
      unmount signal -- is *newer still* than `AbortSignal.timeout`, so
      reaching for it to fix (1) makes the compatibility floor worse, not
      better.

   Hence the hand-rolled version: plain `AbortController` + `setTimeout` +
   an `abort` listener, all of which have been available since the API
   shipped. Callers MUST call `dispose()` (the timer would otherwise keep
   the callback alive for the full duration after the request settles, and
   the parent listener would accumulate one entry per request).

   #202 (MNT-032): `parent` is REQUIRED, not optional. Two callers landed in
   the same PR against this helper and used it two different ways -- one
   passed a lifecycle signal, the other passed nothing and layered a
   `let cancelled` flag on top. The flag is the weaker idiom: it lets an
   abandoned request run to completion and only then declines to use the
   result, so a view that unmounts mid-flight still pays for the response.
   Requiring the parameter means the next caller cannot pick the weaker one
   without noticing. Pass `null` only if a caller genuinely has no lifecycle
   to follow -- and say why at the call site, because none does today.
   -------------------------------------------------------------------------- */

export interface DisposableSignal {
  signal: AbortSignal;
  /** Clears the timer and detaches the parent listener. Safe to call more
   *  than once, and safe to call after the signal has already aborted. */
  dispose: () => void;
}

export function abortAfter(ms: number, parent: AbortSignal | null): DisposableSignal {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    // Matches what AbortSignal.timeout() would have produced, so callers can
    // distinguish "timed out" from "unmounted" by `reason.name` if they need
    // to. Today both are handled identically -- see the AbortError check in
    // TaCapabilitiesView.toggle.
    controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
  }, ms);

  const followParent = () => controller.abort(parent?.reason);

  if (parent) {
    if (parent.aborted) followParent();
    else parent.addEventListener("abort", followParent, { once: true });
  }

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", followParent);
    },
  };
}
