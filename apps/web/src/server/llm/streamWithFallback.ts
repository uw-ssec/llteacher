/* --------------------------------------------------------------------------
   #98/#364: one level of provider failover on the chat path.

   The failure this exists for: the configured provider (or a specific model
   behind it) returns 429/5xx, and a student mid-homework gets "The tutor
   stopped partway through" instead of an answer. An instructor who
   configured a fallback has said what should happen instead.

   WHERE THE FAILOVER WINDOW IS, precisely, because the boundary is the whole
   design and pretending otherwise would be worse than not having it:

     · Everything that fails BEFORE the first content chunk is recoverable:
       not one byte has reached the student, so switching models is invisible
       to them, which is what "the user sees a seamless response" means.

     · Everything that fails AFTER it is not. Once tokens are streaming, a
       mid-stream provider error keeps today's behaviour exactly -- the
       error envelope in chat.ts, and no persistence of a half-turn (#268).
       Re-running the turn on the fallback would either duplicate visible
       text or discard what the student already read.

   HOW THAT BOUNDARY IS DETECTED, and why it is not `await result.response`.

   #364: this module originally awaited `result.response`, on the stated
   premise that it "resolves once the provider's RESPONSE HEADERS arrive --
   so it forces the request, rejects on an immediate provider failure, and
   does NOT buffer the body." That premise is FALSE for the pinned
   ai@5.0.195, and wiring the module to chat.ts on it would have silently
   destroyed streaming. In that version (node_modules/ai/dist/index.mjs):

       get response() { return this.finalStep.then(s => s.response); }
       get steps()    { this.consumeStream(); return this._steps.promise; }

   and `_steps` is settled only inside the recording stream's `flush()` --
   i.e. after the LAST chunk of the turn. Measured against a real streamText
   over a fake LanguageModelV2: first text-delta at 195ms, `response`
   settling at 325ms, on a stream whose chunks were 60ms apart. Awaiting it
   would have made time-to-first-token equal to whole-turn latency for every
   student, on every turn -- the exact opposite of the "TTFT is therefore
   unchanged" this module used to claim. (It is also why #350 found that
   promise hangs forever on a cancelled stream.)

   So the probe is the thing that actually marks the boundary: read
   `result.fullStream` until the first chunk that either COMMITS the turn
   (any content-bearing chunk -- see COMMITTING_CHUNK_TYPES) or fails it (an
   `error` chunk, which is how ai@5.0.195 delivers a provider failure -- the
   stream still closes normally, it does not reject). `fullStream` is a
   `.tee()` branch (the SDK's own `teeStream()`), so peeking it does not
   consume the branch `toUIMessageStreamResponse` later takes: the full text
   still reaches the client afterwards, verified rather than assumed.

   WHAT THE PROBE DOES COST, stated because it is a real trade and not a
   free win (final review). TEXT time-to-first-token is preserved -- the
   probe peeks a tee'd branch and returns on the very chunk the client would
   have rendered first. But constructing the HTTP RESPONSE is now DEFERRED
   until that chunk arrives. chat.ts awaits this function before it can call
   `toUIMessageStreamResponse`, so the response line, its headers -- notably
   `x-conversation-id`, which is how a first-turn client learns the
   conversation it just created -- and the SDK's opening `start` /
   `start-step` framing no longer go out immediately, synchronously, ahead of
   any model output. They now go out with the first committing chunk.

   Concretely: on a slow-first-token turn the client holds a connection with
   no response headers for as long as the model takes to produce anything, up
   to chat.ts's STREAM_TIMEOUT_MS, where previously it had headers and stream
   framing in hand within milliseconds. Nothing is lost -- the header is
   correct whenever the response does resolve (proven in
   routes/chat.fallback.integration.test.ts, which gates the model's first
   chunk on a promise so the assertion can't pass by timing luck) -- and the
   exchange buys a failover window that is otherwise unimplementable, since
   ai@5.0.195 gives no earlier signal that a turn will fail. It is a
   deliberate trade, not an accident of the implementation.

   THIS FUNCTION NEVER THROWS. It chooses WHICH result to hand downstream and
   says who served it; it is not an error-raising layer. When there is no
   fallback, when the failure is not the kind a different model would
   survive, or when the fallback fails too, it returns the corresponding
   result and chat.ts's existing handling runs on it completely unchanged --
   the in-stream `error` chunk still reaches `onError`, `onFinish` still
   fires, the `llm_call_logs` row is still written, and the student still
   gets the #334 `tutor_stopped` envelope rather than a bare 503. That is
   what makes adding this to a live chat path safe: a config with no
   fallback behaves byte-for-byte as it did before this existed.

   This is deliberately one hop and not a chain. `resolveFallbackLLMConfig`
   (lib/llm-config.ts) reads exactly one level, so there is no traversal to
   cycle, and the schema's self-reference CHECK closes the degenerate case.
   An arbitrary chain would need cycle detection at every hop and make "which
   model served this turn" unbounded, to answer a failure mode nobody has had.
   -------------------------------------------------------------------------- */

import { streamText } from "ai";
import { logServerError, logServerWarn } from "../utils/errors";

type StreamTextParams = Parameters<typeof streamText>[0];
type StreamTextResult = ReturnType<typeof streamText>;

/** What served the turn, so the caller can attribute it.
 *
 *  #364: chat.ts's `onFinish` uses `usedFallback` to pick which resolved
 *  config the turn's single `llm_call_logs` row is written under, so
 *  `provider`/`model`/`llm_config_id` name whoever actually served it rather
 *  than the primary that didn't. */
export interface StreamAttribution {
  /** The model id that actually produced the turn. */
  servedBy: string;
  /** True when the primary failed before committing and the fallback took
   *  over. A rising rate of these is the signal #48 reports on: it means the
   *  primary provider is in trouble, which nothing else would surface. */
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
  // deadline the fallback would hit too (chat.ts's STREAM_TIMEOUT_MS is a
  // per-turn budget, not a per-attempt one). Retrying an aborted turn spends
  // a call for a student who is no longer reading. Checked before the
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

/** Chunk types that mean the turn is COMMITTED -- something the student can
 *  see (or that the client has begun rendering) is on its way, so switching
 *  models is no longer invisible and the window has closed.
 *
 *  Deliberately excludes the SDK's own bookkeeping chunks (`start`,
 *  `start-step`, `response-metadata`, `finish-step`, `finish`), which
 *  ai@5.0.195 emits before it knows whether the provider will answer at all
 *  -- an error-only turn still begins with them. Treating `start` as a
 *  commitment would make the failover window empty and this whole module a
 *  no-op, which is precisely the bug a bare `parts.length` check caused in
 *  chat.ts's own `hasRenderableContent` (see its #268 doc comment). */
const COMMITTING_CHUNK_TYPES: ReadonlySet<string> = new Set([
  "text-delta",
  "reasoning-delta",
  "tool-input-delta",
  "tool-call",
  "tool-result",
  "file",
  "source",
]);

/* #422: the `*-start` markers are deliberately NOT in the set above.

   They OPEN a part; they carry none of its bytes. A gateway that emits
   `text-start` and then 500s -- the ordinary shape of an upstream failure on
   an OpenAI-compatible proxy such as LLMoxie/LiteLLM -- had already
   "committed" the turn under the old set, so the error chunk that arrived
   immediately after was never inspected, isRetryableProviderError was never
   called, and a healthy configured fallback went unused while the student got
   `tutor_stopped`.

   Nothing had reached the student at that moment: this module's own header
   records that the HTTP response is not constructed until the probe returns,
   so switching models there is still completely invisible. The boundary this
   module documents is "before the first content chunk", and a part-opening
   marker is not content.

   Kept as a named set rather than deleted so the distinction stays legible:
   these are the chunks that prove a part EXISTS, and the ones above are the
   chunks that prove it has CONTENT. */
const PART_OPENING_CHUNK_TYPES: ReadonlySet<string> = new Set([
  "text-start",
  "reasoning-start",
  "tool-input-start",
]);

type ProbeOutcome = { committed: true } | { committed: false; error: unknown };

/** Reads one tee branch of the result's stream up to the first chunk that
 *  either commits or fails the turn. Cancels that branch before returning --
 *  the branch `toUIMessageStreamResponse` takes later is a separate one and
 *  still carries every chunk, including the ones read here.
 *
 *  A stream that ends (or reaches `finish`) with neither content nor an error
 *  counts as COMMITTED: an empty-but-successful turn is not a provider
 *  failure, and chat.ts already has a purpose-built path for it
 *  (`hasRenderableContent` -> not persisted, logged, `llm_call_logs` row with
 *  errorFlag). Failing over there would spend a second paid call to reproduce
 *  a non-error. */
async function probeUntilCommitted(result: StreamTextResult): Promise<ProbeOutcome> {
  const reader = result.fullStream.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return { committed: true };
      if (value.type === "error") return { committed: false, error: value.error };
      /* #424: a hang that runs out the turn's abortSignal. ai@5.0.195 does
         NOT surface that as an `error` chunk -- it discards the AbortError
         and enqueues `{type:"abort"}`, then closes -- so this matched
         nothing, fell through to `done`, and was reported as COMMITTED.
         A provider that accepts the connection and never answers is the
         single most common outage shape, and it was the one shape that
         could never fail over, despite zero bytes reaching the student.

         Not folded into the `done` case: "the stream ended" and "the stream
         was aborted" are different facts, and only the second is a failure.
         An empty-but-successful turn still commits (see the doc comment). */
      if (value.type === "abort") {
        /* Named AbortError so isRetryableProviderError's EXISTING, documented
           policy applies to it on purpose: a turn that ran out
           chat.ts's STREAM_TIMEOUT_MS has spent a budget that is per-TURN,
           not per-attempt, so a second hop would blow the same deadline for a
           student who has already waited it out. #424 does not change that
           decision -- it makes the turn reach it.

           What does change: the turn is now classified as a FAILURE rather
           than a commitment, so it is logged as one (streamWithFallback.
           primaryFailed) instead of passing silently as an empty-but-
           successful turn. A provider that accepts connections and never
           answers was previously the one outage shape that produced no
           failover signal at all. */
        return {
          committed: false,
          error: Object.assign(new Error("provider aborted before producing any content"), { name: "AbortError" }),
        };
      }
      if (value.type === "finish") return { committed: true };
      if (COMMITTING_CHUNK_TYPES.has(value.type)) return { committed: true };
      // #422: part-opening markers explicitly do not commit; keep reading
      // until real content or a failure arrives.
      if (PART_OPENING_CHUNK_TYPES.has(value.type)) continue;
    }
  } catch (err) {
    // A genuine stream rejection rather than an in-band `error` chunk. Both
    // mean the same thing here: nothing reached the student.
    return { committed: false, error: err };
  } finally {
    // Releases this branch's buffer. Cancelling one `.tee()` branch does not
    // cancel the source while the other branch is still live, so the result
    // handed back below remains fully readable.
    await reader.cancel().catch(() => {});
  }
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
 *  before any content is committed.
 *
 *  Returns the live stream plus what served it, always -- see this module's
 *  header for why this never throws and why that is what makes it safe to
 *  put in front of a live chat path. */
export async function streamWithFallback(
  attempt: FallbackAttempt,
): Promise<{ result: StreamTextResult; attribution: StreamAttribution }> {
  const primary = streamText(attempt.primary);
  const primaryOutcome = await probeUntilCommitted(primary);

  if (primaryOutcome.committed) {
    return {
      result: primary,
      attribution: { servedBy: attempt.primaryModelName, usedFallback: false },
    };
  }

  const err = primaryOutcome.error;
  const retryable = isRetryableProviderError(err);
  // #275: structured fields, not a context string with the identifiers
  // interpolated into it -- `context` stays a fixed, greppable label and
  // everything variable is a field a log query can filter or group on.
  logServerError("streamWithFallback.primaryFailed", err instanceof Error ? err : new Error(String(err)), {
    logContext: attempt.logContext,
    primaryModel: attempt.primaryModelName,
    fallbackModel: attempt.fallbackModelName ?? null,
    retryable,
  });

  // No fallback configured, or a fault the fallback would share: hand the
  // primary's own result back so the caller's existing handling runs on it
  // unchanged. Not substituting anything is the point -- a student seeing the
  // normal error is better than one seeing a second failure two seconds later.
  if (!retryable || !attempt.fallback || !attempt.fallbackModelName) {
    return {
      result: primary,
      attribution: { servedBy: attempt.primaryModelName, usedFallback: false },
    };
  }

  /* #423: drain the primary that is being abandoned.

     probeUntilCommitted cancelled only its OWN tee branch, and in ai@5.0.195
     cancelling one branch of a `.tee()` does not cancel the source while
     another branch is uncancelled. The branch toUIMessageStreamResponse would
     have taken is never read again -- this function returns `backup` -- so
     without this the failed primary's pipeline, and the provider response
     body behind it, stay open for the rest of the request.

     DRAINED, not cancelled, and the distinction is worth stating: every
     `fullStream` access calls teeStream() and hands back a NEW branch (the
     getter is `createAsyncIterableStream(this.teeStream()...)`), so
     cancelling `result.fullStream` cancels a freshly-minted branch and does
     nothing to the source. Reading one branch to completion DOES pull the
     source to completion, which is what releases the upstream fetch. That is
     what the old `drain()` achieved incidentally by awaiting `result.text`,
     and nothing replaced it when it was removed.

     Not awaited: the fallback should start immediately, and the drain is
     bookkeeping. Errors are swallowed -- the primary already failed, and its
     error is reported above. */
  void primary.consumeStream({ onError: () => {} });

  const backup = streamText(attempt.fallback);
  const backupOutcome = await probeUntilCommitted(backup);
  if (!backupOutcome.committed) {
    // One hop, no chain: the fallback's failure IS the outcome, and the
    // caller handles it exactly as it would have handled the primary's. Still
    // attributed to the fallback -- it is the attempt whose error the student
    // is about to see, and the one the `llm_call_logs` row should name.
    logServerWarn(
      "streamWithFallback.fallbackAlsoFailed",
      "both the primary and its configured fallback failed before committing",
      {
        logContext: attempt.logContext,
        primaryModel: attempt.primaryModelName,
        fallbackModel: attempt.fallbackModelName,
      },
    );
  }
  return {
    result: backup,
    attribution: {
      servedBy: attempt.fallbackModelName,
      usedFallback: true,
      primaryError: err instanceof Error ? err.message : String(err),
    },
  };
}
