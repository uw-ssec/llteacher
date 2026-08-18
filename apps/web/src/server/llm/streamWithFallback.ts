/* --------------------------------------------------------------------------
   #98: one level of provider failover on the chat path.

   The failure this exists for: OpenRouter (or a specific model behind it)
   returns 429/5xx, and a student mid-homework gets "The tutor stopped
   partway through" instead of an answer. An instructor who configured a
   fallback has said what should happen instead.

   WHERE THE FAILOVER WINDOW IS, precisely, because the boundary is the whole
   design and pretending otherwise would be worse than not having it:

     · `streamText` returns synchronously; the provider round trip has not
       happened yet. Awaiting `result.response` resolves once the provider's
       RESPONSE HEADERS arrive -- so it forces the request, rejects on an
       immediate provider failure (bad model id, 401, 429, 5xx, connect
       timeout), and does NOT buffer the body. Time to first token is
       therefore unchanged for the happy path.

     · Everything that fails in that window is recoverable: not one byte has
       reached the student, so switching models is invisible to them, which
       is what "the user sees a seamless response" means.

     · Everything that fails AFTER it is not. Once tokens are streaming, a
       mid-stream provider error keeps today's behaviour exactly -- the
       error envelope in chat.ts, and no persistence of a half-turn (#268).
       Re-running the turn on the fallback would either duplicate visible
       text or discard what the student already read.

   This is deliberately one hop and not a chain. `resolveFallbackConfig`
   reads exactly one level, so there is no traversal to cycle, and the
   schema's self-reference CHECK closes the degenerate case. An arbitrary
   chain would need cycle detection at every hop and make "which model served
   this turn" unbounded, to answer a failure mode nobody has had.
   -------------------------------------------------------------------------- */

import { streamText } from "ai";
import { logServerError } from "../utils/errors";

type StreamTextParams = Parameters<typeof streamText>[0];
type StreamTextResult = ReturnType<typeof streamText>;

/** What served the turn, so the caller can attribute it.
 *
 *  #98 asks for this to reach the call log (#45) and the fallback-rate
 *  report (#48). Neither exists yet -- nothing in the tree writes
 *  `llm_call_logs` -- so this is returned and logged rather than persisted.
 *  When #45 lands, the row it writes takes `servedBy` and `usedFallback`
 *  straight from here; the shape is the point of returning it now. */
export interface StreamAttribution {
  /** The model id that actually produced the turn. */
  servedBy: string;
  /** True when the primary failed and the fallback answered. A rising rate
   *  of these is the signal #48 reports on: it means the primary provider is
   *  in trouble, which nothing else in the system would surface. */
  usedFallback: boolean;
  /** Present when the primary failed, for the log. Never shown to a student. */
  primaryError?: string;
}

/** Provider failures worth trying a different model for.
 *
 *  Deliberately a small allowlist rather than "anything that throws". A
 *  malformed request, a content-policy refusal, or a prompt that exceeds the
 *  context window will fail on the fallback in exactly the same way -- so
 *  retrying spends a second call, doubles the latency before the student
 *  sees the error, and reports the fallback's name in the logs for a fault
 *  that was never the primary's.
 *
 *  Matched on status first, since every provider sets one; the string checks
 *  are for transport-level failures that never reach an HTTP status. */
export function isRetryableProviderError(err: unknown): boolean {
  const status =
    (err as { statusCode?: number })?.statusCode ??
    (err as { status?: number })?.status ??
    (err as { response?: { status?: number } })?.response?.status;

  if (typeof status === "number") {
    // 429 rate limit, 408 request timeout, and any 5xx: the provider is
    // saying "not now", not "not ever".
    return status === 408 || status === 429 || status >= 500;
  }

  // No status: a transport failure. `name` is checked before `message`
  // because it is the stable half -- provider prose changes, DOMException
  // names do not.
  const name = (err as Error)?.name ?? "";
  // AbortError is NOT retryable: the caller went away, or the request hit a
  // deadline the fallback would hit too. Retrying an aborted turn spends a
  // call for a student who is no longer reading. Checked before the
  // retryable names so it cannot be overridden by a later match.
  if (name === "AbortError") return false;
  if (name === "TimeoutError" || name === "APICallError") return true;

  const message = String((err as Error)?.message ?? "").toLowerCase();
  return (
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("econnreset") ||
    message.includes("socket hang up")
  );
}

/** Attaches no-op handlers to the promises an abandoned streamText result
 *  rejects alongside `response`. Nothing awaits them, so without this each
 *  one becomes an unhandled rejection. */
function drain(result: StreamTextResult): void {
  void result.text.catch(() => {});
  void result.usage.catch(() => {});
}

export interface FallbackAttempt {
  /** Params for the primary model, ready to hand to streamText. */
  primary: StreamTextParams;
  /** Params for the fallback, or null when the config names none. */
  fallback: StreamTextParams | null;
  primaryModelName: string;
  fallbackModelName: string | null;
  /** Correlation for the logs -- the conversation this turn belongs to. */
  logContext: string;
}

/** Starts the turn on the primary, and on the fallback if the primary fails
 *  before any bytes are committed.
 *
 *  Returns the live stream plus what served it. Throws only when there is
 *  nothing left to try -- the caller's existing error handling then applies
 *  unchanged, which is why a config with no fallback behaves exactly as it
 *  did before this existed. */
export async function streamWithFallback(
  attempt: FallbackAttempt,
): Promise<{ result: StreamTextResult; attribution: StreamAttribution }> {
  const primary = streamText(attempt.primary);
  try {
    // Resolves on response headers -- forces the request without buffering
    // the body. See the header comment for why this is the whole window.
    await primary.response;
    return {
      result: primary,
      attribution: { servedBy: attempt.primaryModelName, usedFallback: false },
    };
  } catch (err) {
    // The abandoned result's other promises (.text, .usage) reject too.
    // Nothing awaits them, and an unhandled rejection in a Worker is a
    // logged noise event at best, so they are drained explicitly rather
    // than left dangling.
    drain(primary);

    const retryable = isRetryableProviderError(err);
    logServerError(
      `${attempt.logContext} primary=${attempt.primaryModelName} retryable=${retryable} fallback=${attempt.fallbackModelName ?? "none"}`,
      err,
    );

    // No fallback configured, or a fault the fallback would share: rethrow
    // so the caller's existing handling runs. Not swallowing it is the
    // point -- a student seeing the normal error is better than one seeing
    // a second failure two seconds later.
    if (!retryable || !attempt.fallback || !attempt.fallbackModelName) throw err;

    const backup = streamText(attempt.fallback);
    try {
      await backup.response;
    } catch (fallbackErr) {
      // One hop, no chain: the fallback's rejection IS the outcome, and the
      // caller handles it exactly as it would have handled the primary's.
      // The try exists only to drain -- an earlier version let the backup's
      // .text/.usage dangle, which is the same unhandled-rejection hazard
      // the primary's drain above exists to prevent, reintroduced on the
      // one path where TWO attempts have failed.
      drain(backup);
      throw fallbackErr;
    }
    return {
      result: backup,
      attribution: {
        servedBy: attempt.fallbackModelName,
        usedFallback: true,
        primaryError: (err as Error)?.message,
      },
    };
  }
}
