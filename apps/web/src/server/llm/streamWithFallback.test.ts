/* --------------------------------------------------------------------------
   #98/#364: provider failover.

   What these pin is the BOUNDARY, because it is the whole design: a failure
   before any content reaches the student is recoverable and switches models
   invisibly; a failure after it is not, and must keep chat.ts's existing
   behaviour rather than replaying a turn the student has already read half of.

   #364: the doubles below are STREAMS, not a `response` promise. The module
   used to await `result.response` on the premise that it settles when the
   provider's response headers arrive; against the pinned ai@5.0.195 it
   settles only after the LAST chunk of the turn (see the module header for
   the measurement), so a test built on a resolved/rejected `response`
   promise was pinning a contract the SDK does not have. These fakes model
   what streamText actually produces: bookkeeping chunks first, then either
   content or an in-band `error` chunk.
   -------------------------------------------------------------------------- */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { isRetryableProviderError, streamWithFallback } from "./streamWithFallback";

const streamTextMock = vi.fn();
vi.mock("ai", () => ({ streamText: (args: unknown) => streamTextMock(args) }));

type Chunk = { type: string; error?: unknown };

/** A streamText double whose `fullStream` is a fresh ReadableStream per
 *  access, mirroring the SDK's `teeStream()` -- so the module's probe read
 *  cannot starve a later consumer, which is the property the real `.tee()`
 *  provides and the reason peeking is safe at all. */
function fakeResult(chunks: Chunk[], marker: string) {
  let branches = 0;
  let drained = 0;
  return {
    marker,
    get branchCount() {
      return branches;
    },
    /** #423: how many times the abandoned primary was drained. The real
     *  SDK's consumeStream is what pulls the source to completion and lets
     *  the provider response body go; the module calls it on the failover
     *  path, so the double has to offer it. */
    get drainCount() {
      return drained;
    },
    consumeStream: async (_opts?: { onError?: (e: unknown) => void }) => {
      drained += 1;
    },
    get fullStream() {
      branches += 1;
      return new ReadableStream<Chunk>({
        start(controller) {
          for (const c of chunks) controller.enqueue(c);
          controller.close();
        },
      });
    },
  };
}

/** The chunk prefix ai@5.0.195 emits before it knows whether the provider
 *  will answer at all -- an error-only turn still begins with these. */
const PREAMBLE: Chunk[] = [{ type: "start" }, { type: "start-step" }, { type: "response-metadata" }];

const okStream = (marker = "ok") =>
  fakeResult(
    [...PREAMBLE, { type: "text-start" }, { type: "text-delta" }, { type: "finish" }],
    marker,
  );
const failingStream = (err: unknown, marker = "failed") =>
  fakeResult([...PREAMBLE, { type: "error", error: err }, { type: "finish" }], marker);

const attempt = (over: Record<string, unknown> = {}) => ({
  primary: { model: "primary" } as never,
  fallback: { model: "backup" } as never,
  primaryModelName: "primary/model",
  fallbackModelName: "backup/model",
  logContext: "test",
  ...over,
});

const status = (code: number) => Object.assign(new Error(`HTTP ${code}`), { statusCode: code });

beforeEach(() => {
  streamTextMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("isRetryableProviderError (#98)", () => {
  for (const code of [408, 429, 500, 502, 503, 529]) {
    it(`retries on ${code} -- the provider is saying "not now"`, () => {
      expect(isRetryableProviderError(status(code))).toBe(true);
    });
  }

  for (const code of [400, 401, 403, 404, 422]) {
    it(`does NOT retry on ${code} -- the fallback would fail identically`, () => {
      // Retrying a malformed request, a bad key, or a missing model spends a
      // second call, doubles the time before the student sees the error, and
      // blames the fallback for a fault that was never the primary's.
      expect(isRetryableProviderError(status(code))).toBe(false);
    });
  }

  it("retries transport failures that never reach a status", () => {
    expect(isRetryableProviderError(new TypeError("fetch failed"))).toBe(true);
    expect(isRetryableProviderError(Object.assign(new Error("x"), { name: "TimeoutError" }))).toBe(
      true,
    );
    expect(isRetryableProviderError(new Error("socket hang up"))).toBe(true);
  });

  it("never retries an abort", () => {
    // The caller went away, or the deadline the fallback would also hit has
    // passed. Retrying spends a call for a student who is no longer reading.
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(isRetryableProviderError(abort)).toBe(false);
  });

  it("reads a status from any of the three shapes providers use", () => {
    expect(isRetryableProviderError({ status: 503 })).toBe(true);
    expect(isRetryableProviderError({ statusCode: 503 })).toBe(true);
    expect(isRetryableProviderError({ response: { status: 503 } })).toBe(true);
  });
});

describe("streamWithFallback (#98/#364)", () => {
  it("uses the primary and does not touch the fallback when it works", async () => {
    streamTextMock.mockReturnValueOnce(okStream());
    const { result, attribution } = await streamWithFallback(attempt());
    expect((result as unknown as { marker: string }).marker).toBe("ok");
    expect(attribution).toEqual({ servedBy: "primary/model", usedFallback: false });
    expect(streamTextMock).toHaveBeenCalledTimes(1);
  });

  it("switches to the fallback when the primary errors before any content", async () => {
    streamTextMock.mockReturnValueOnce(failingStream(status(503))).mockReturnValueOnce(okStream());
    const { result, attribution } = await streamWithFallback(attempt());
    // Invisible to the student: not one byte had been sent, which is what
    // "the user sees a seamless response" means.
    expect((result as unknown as { marker: string }).marker).toBe("ok");
    expect(attribution.servedBy).toBe("backup/model");
    expect(attribution.usedFallback).toBe(true);
    expect(attribution.primaryError).toContain("503");
    expect(streamTextMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT fail over once content has been committed", async () => {
    // The boundary itself: an error AFTER a text-delta is a mid-stream
    // failure. Re-running the turn on the fallback would either duplicate
    // text the student already read or discard it.
    streamTextMock.mockReturnValueOnce(
      fakeResult(
        [...PREAMBLE, { type: "text-delta" }, { type: "error", error: status(503) }],
        "committed",
      ),
    );
    const { attribution } = await streamWithFallback(attempt());
    expect(attribution.usedFallback).toBe(false);
    expect(streamTextMock).toHaveBeenCalledTimes(1);
  });

  it("treats a tool call as committed content, not as silence", async () => {
    // #422: `tool-call`, not `tool-input-start`. The start marker only opens
    // the part -- this asserts that real tool CONTENT commits the turn, which
    // is what the test's name has always claimed.
    streamTextMock.mockReturnValueOnce(
      fakeResult([...PREAMBLE, { type: "tool-call" }, { type: "error", error: status(503) }], "tool"),
    );
    const { attribution } = await streamWithFallback(attempt());
    expect(attribution.usedFallback).toBe(false);
    expect(streamTextMock).toHaveBeenCalledTimes(1);
  });

  it("#422: a part-opening marker followed by a provider error still fails over", async () => {
    /* The ordinary shape of an upstream failure on an OpenAI-compatible
       gateway: the part is opened, then the upstream 500s. `text-start`
       carries none of the part's bytes, and the HTTP response is not
       constructed until this probe returns, so nothing had reached the
       student and the switch is still invisible. Before #422 this counted as
       committed and a healthy configured fallback went unused. */
    streamTextMock
      .mockReturnValueOnce(
        fakeResult([...PREAMBLE, { type: "text-start" }, { type: "error", error: status(503) }], "opened-then-died"),
      )
      .mockReturnValueOnce(okStream());

    const { result, attribution } = await streamWithFallback(attempt());

    expect((result as unknown as { marker: string }).marker).toBe("ok");
    expect(attribution.usedFallback).toBe(true);
    expect(streamTextMock).toHaveBeenCalledTimes(2);
  });

  it("#422: an opened part that goes on to produce content still commits", async () => {
    // The other half of the boundary: text-start does not commit, but the
    // text-delta right after it does -- so an ordinary successful turn is
    // unaffected and TTFT is unchanged.
    streamTextMock.mockReturnValueOnce(
      fakeResult(
        [...PREAMBLE, { type: "text-start" }, { type: "text-delta" }, { type: "error", error: status(503) }],
        "real-content",
      ),
    );
    const { attribution } = await streamWithFallback(attempt());
    expect(attribution.usedFallback).toBe(false);
    expect(streamTextMock).toHaveBeenCalledTimes(1);
  });

  it("#424: a hung provider is reported as a failure, and still does not fail over", async () => {
    /* ai@5.0.195 does not deliver an aborted stream as an `error` chunk -- it
       discards the AbortError and enqueues `{type:"abort"}`, then closes.
       That matched nothing in the probe, fell through to `done`, and was
       reported as COMMITTED: the single most common outage shape (connection
       accepted, no answer) produced no failure signal whatsoever.

       It still must not fail over -- STREAM_TIMEOUT_MS is a per-TURN budget
       and the second hop would blow the same deadline -- so this pins BOTH
       halves: the decision is unchanged, and it is now reached deliberately
       rather than by falling through a gap. */
    streamTextMock.mockReturnValueOnce(fakeResult([...PREAMBLE, { type: "abort" }], "hung"));

    const { result, attribution } = await streamWithFallback(attempt());

    expect((result as unknown as { marker: string }).marker).toBe("hung");
    expect(attribution.usedFallback).toBe(false);
    expect(streamTextMock).toHaveBeenCalledTimes(1);
    // The half that actually changed: an operator can now see the hang.
    expect(console.error).toHaveBeenCalled();
  });

  it("#423: drains the abandoned primary so its provider body is released", async () => {
    const primary = fakeResult([...PREAMBLE, { type: "error", error: status(503) }], "abandoned");
    streamTextMock.mockReturnValueOnce(primary).mockReturnValueOnce(okStream());

    await streamWithFallback(attempt());

    /* Cancelling the probe's own tee branch does not cancel the source while
       another branch is live, and the branch toUIMessageStreamResponse would
       have taken is never read -- so without an explicit drain the primary's
       pipeline stays open for the rest of the request. */
    expect(primary.drainCount).toBe(1);
  });

  it("does not fail over for an empty-but-successful turn", async () => {
    // No content and no error is not a provider failure -- chat.ts has a
    // purpose-built path for it (hasRenderableContent). Failing over would
    // spend a second paid call to reproduce a non-error.
    streamTextMock.mockReturnValueOnce(fakeResult([...PREAMBLE, { type: "finish" }], "empty"));
    const { attribution } = await streamWithFallback(attempt());
    expect(attribution.usedFallback).toBe(false);
    expect(streamTextMock).toHaveBeenCalledTimes(1);
  });

  it("returns the primary's own result, without a second call, when the failure is not retryable", async () => {
    streamTextMock.mockReturnValueOnce(failingStream(status(400)));
    const { result, attribution } = await streamWithFallback(attempt());
    // #364: hands the failure downstream rather than throwing, so chat.ts's
    // existing error-chunk handling (onError -> the #334 `tutor_stopped`
    // envelope, plus the llm_call_logs row) runs on it unchanged.
    expect((result as unknown as { marker: string }).marker).toBe("failed");
    expect(attribution.usedFallback).toBe(false);
    expect(streamTextMock).toHaveBeenCalledTimes(1);
  });

  it("behaves exactly as before when no fallback is configured", async () => {
    // The property that makes this safe to add to a live chat path: a config
    // without a fallback is the single streamText call it replaced.
    streamTextMock.mockReturnValueOnce(failingStream(status(503)));
    const { result, attribution } = await streamWithFallback(
      attempt({ fallback: null, fallbackModelName: null }),
    );
    expect((result as unknown as { marker: string }).marker).toBe("failed");
    expect(attribution.usedFallback).toBe(false);
    expect(streamTextMock).toHaveBeenCalledTimes(1);
  });

  it("does not chain -- a failing fallback is the outcome, not a third attempt", async () => {
    streamTextMock
      .mockReturnValueOnce(failingStream(status(503), "primary-failed"))
      .mockReturnValueOnce(failingStream(status(503), "backup-failed"));
    const { result, attribution } = await streamWithFallback(attempt());
    expect((result as unknown as { marker: string }).marker).toBe("backup-failed");
    // Attributed to the fallback: it is the attempt whose error the student
    // is about to see, and the one the llm_call_logs row should name.
    expect(attribution.servedBy).toBe("backup/model");
    expect(attribution.usedFallback).toBe(true);
    expect(streamTextMock).toHaveBeenCalledTimes(2);
  });

  it("leaves nothing unhandled when both attempts fail", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    streamTextMock
      .mockReturnValueOnce(failingStream(status(503)))
      .mockReturnValueOnce(failingStream(status(503)));
    await streamWithFallback(attempt());
    await new Promise((r) => setTimeout(r, 10));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("leaves the served result's stream unread, for the caller to consume", async () => {
    // The probe takes its OWN tee branch and cancels it; the branch
    // toUIMessageStreamResponse takes later must still carry the whole turn.
    // Verified end-to-end against the real SDK in chat.fallback.integration
    // -- here, that the module only ever took one branch of its own.
    const served = okStream();
    streamTextMock.mockReturnValueOnce(served);
    await streamWithFallback(attempt());
    expect(served.branchCount).toBe(1);
  });

  it("passes each attempt its own params, unmixed", async () => {
    streamTextMock.mockReturnValueOnce(failingStream(status(503))).mockReturnValueOnce(okStream());
    await streamWithFallback(attempt());
    expect(streamTextMock.mock.calls[0]![0]).toMatchObject({ model: "primary" });
    expect(streamTextMock.mock.calls[1]![0]).toMatchObject({ model: "backup" });
  });
});
