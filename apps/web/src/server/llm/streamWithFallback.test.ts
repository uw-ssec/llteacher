/* --------------------------------------------------------------------------
   #98: provider failover.

   What these pin is the BOUNDARY, because it is the whole design: a failure
   before any byte reaches the student is recoverable and switches models
   invisibly; a failure after it is not, and must keep chat.ts's existing
   behaviour rather than replaying a turn the student has already read half of.
   -------------------------------------------------------------------------- */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { isRetryableProviderError, streamWithFallback } from "./streamWithFallback";

const streamTextMock = vi.fn();
vi.mock("ai", () => ({ streamText: (args: unknown) => streamTextMock(args) }));

/** A streamText double. `response` is what streamWithFallback awaits to
 *  force the provider round trip; `fails` makes that reject, which is a
 *  failure BEFORE any content -- the recoverable window. */
function fakeResult(opts: { fails?: unknown } = {}) {
  const rejected = opts.fails !== undefined;
  return {
    response: rejected ? Promise.reject(opts.fails) : Promise.resolve({ id: "r" }),
    // Rejected alongside `response` in the real SDK. Present so the helper's
    // drain does not itself produce an unhandled rejection.
    text: rejected ? Promise.reject(opts.fails) : Promise.resolve("hello"),
    usage: rejected ? Promise.reject(opts.fails) : Promise.resolve({}),
    marker: rejected ? "failed" : "ok",
  };
}

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

describe("streamWithFallback (#98)", () => {
  it("uses the primary and does not touch the fallback when it works", async () => {
    streamTextMock.mockReturnValueOnce(fakeResult());
    const { result, attribution } = await streamWithFallback(attempt());
    expect((result as unknown as { marker: string }).marker).toBe("ok");
    expect(attribution).toEqual({ servedBy: "primary/model", usedFallback: false });
    expect(streamTextMock).toHaveBeenCalledTimes(1);
  });

  it("switches to the fallback when the primary fails before any content", async () => {
    streamTextMock
      .mockReturnValueOnce(fakeResult({ fails: status(503) }))
      .mockReturnValueOnce(fakeResult());
    const { attribution } = await streamWithFallback(attempt());
    // Invisible to the student: not one byte had been sent, which is what
    // "the user sees a seamless response" means.
    expect(attribution.servedBy).toBe("backup/model");
    expect(attribution.usedFallback).toBe(true);
    expect(attribution.primaryError).toContain("503");
    expect(streamTextMock).toHaveBeenCalledTimes(2);
  });

  it("rethrows without a second call when the failure is not retryable", async () => {
    streamTextMock.mockReturnValueOnce(fakeResult({ fails: status(400) }));
    await expect(streamWithFallback(attempt())).rejects.toThrow(/400/);
    expect(streamTextMock).toHaveBeenCalledTimes(1);
  });

  it("rethrows when no fallback is configured, behaving exactly as before", async () => {
    // The property that makes this safe to add: a config without a fallback
    // is the single streamText call it replaced.
    streamTextMock.mockReturnValueOnce(fakeResult({ fails: status(503) }));
    await expect(
      streamWithFallback(attempt({ fallback: null, fallbackModelName: null })),
    ).rejects.toThrow(/503/);
    expect(streamTextMock).toHaveBeenCalledTimes(1);
  });

  it("does not chain -- a failing fallback is the outcome, not a third attempt", async () => {
    streamTextMock
      .mockReturnValueOnce(fakeResult({ fails: status(503) }))
      .mockReturnValueOnce(fakeResult({ fails: status(503) }));
    await expect(streamWithFallback(attempt())).rejects.toThrow(/503/);
    expect(streamTextMock).toHaveBeenCalledTimes(2);
  });

  it("drains BOTH attempts' promises when both fail", async () => {
    // The path where two attempts have failed is the one an earlier version
    // of this helper got wrong: the primary was drained, the fallback was
    // not, and its .text/.usage became unhandled rejections a tick later --
    // in a Worker, logged noise at best and a kill at worst.
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    streamTextMock
      .mockReturnValueOnce(fakeResult({ fails: status(503) }))
      .mockReturnValueOnce(fakeResult({ fails: status(503) }));
    await streamWithFallback(attempt()).catch(() => {});
    await new Promise((r) => setTimeout(r, 10));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("drains the abandoned attempt's promises so nothing is left unhandled", async () => {
    // An unhandled rejection in a Worker is logged noise at best and a kill
    // at worst; the abandoned result's text/usage reject alongside response.
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    streamTextMock
      .mockReturnValueOnce(fakeResult({ fails: status(503) }))
      .mockReturnValueOnce(fakeResult());
    await streamWithFallback(attempt());
    await new Promise((r) => setTimeout(r, 10));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("passes each attempt its own params, unmixed", async () => {
    streamTextMock
      .mockReturnValueOnce(fakeResult({ fails: status(503) }))
      .mockReturnValueOnce(fakeResult());
    await streamWithFallback(attempt());
    expect(streamTextMock.mock.calls[0]![0]).toMatchObject({ model: "primary" });
    expect(streamTextMock.mock.calls[1]![0]).toMatchObject({ model: "backup" });
  });
});
