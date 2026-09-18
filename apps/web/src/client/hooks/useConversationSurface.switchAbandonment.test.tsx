// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, cleanup, waitFor } from "@testing-library/react";
import { useConversationSurface, type UseConversationSurfaceOptions } from "./useConversationSurface";

/* #449/#450 (Cordero review, PR440): unlike useConversationSurface.test.tsx,
   this file deliberately does NOT mock "@ai-sdk/react" -- these two bugs are
   specifically about @ai-sdk/react's OWN Chat-instance-recreation mechanics
   (`shouldRecreateChat`, `useSyncExternalStore` per-instance subscriptions),
   which a hand-rolled useChat stub can't reproduce. The REAL `useChat` runs
   here; only the network boundary (`fetchImpl`) is controlled, exactly the
   way this hook's own contract expects a caller to control it. */

afterEach(() => {
  cleanup();
});

function baseOptions(overrides: Partial<UseConversationSurfaceOptions>): UseConversationSurfaceOptions {
  return {
    surfaceKey: "conv-A",
    resetKey: "conv-A",
    stoppedMessageResetKey: "conv-A",
    initialMessages: [],
    fetchImpl: vi.fn().mockResolvedValue(new Response("[]", { status: 200 })) as unknown as typeof fetch,
    buildSendBody: () => ({}),
    buildRetryBody: () => ({}),
    hydrationError: null,
    ...overrides,
  };
}

describe("useConversationSurface: switch-abandoned send-half failure (#449)", () => {
  it("still recovers the student's unsent text after the surface it was sent from has already been recreated", async () => {
    let rejectHungSend: ((err: unknown) => void) | undefined;
    const fetchImpl = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          // Only the SEND under conv-A hangs -- a real send-half failure
          // reproduction needs a REAL rejected fetch, not a synthetic one,
          // since #449's whole bug is about whether @ai-sdk/react's own
          // Chat#makeRequest catch (which this promise feeds) still routes
          // back to a subscriber that still cares by the time it settles.
          const body = init?.body ? String(init.body) : "";
          if (body.includes("lost text")) {
            rejectHungSend = reject;
          } else {
            reject(new Error("unexpected fetch in this test"));
          }
        }),
    ) as unknown as typeof fetch;

    const { result, rerender } = renderHook((opts: UseConversationSurfaceOptions) => useConversationSurface(opts), {
      initialProps: baseOptions({ fetchImpl }),
    });

    // Dispatch a send under conv-A. This is the turn that will be abandoned.
    act(() => {
      result.current.send("lost text");
    });
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());

    // The switch completes BEFORE the hung send settles -- exactly the
    // "ordinary impatience" ordering Cordero's review describes: a fast,
    // successful history fetch for the NEW surface completing while the
    // OLD send is still a slow/dead connection. `surfaceKey` genuinely
    // changing here is what recreates @ai-sdk/react's own Chat instance
    // (`shouldRecreateChat`) -- this is the one thing the fully-mocked
    // useConversationSurface.test.tsx CANNOT reproduce.
    rerender(
      baseOptions({
        surfaceKey: "conv-B",
        resetKey: "conv-B",
        stoppedMessageResetKey: "conv-B",
        fetchImpl,
      }),
    );

    // conv-B's own surface has no failure of its own.
    expect(result.current.sendFailure).toBeNull();

    // NOW the abandoned conv-A send finally dies -- a dead connection that
    // just took a while to notice.
    act(() => {
      rejectHungSend?.(new TypeError("Load failed"));
    });

    // Pre-#449: nothing ever observes this rejection (the OLD Chat instance
    // this promise belongs to is no longer what useChat() returns), so
    // sendFailureRecord is never created at all -- not just gated to null
    // while on conv-B, but permanently gone, even after switching BACK.
    // Give any (would-be) async handling a tick to run before asserting.
    await act(async () => {
      await Promise.resolve();
    });

    // Still correctly gated to null while conv-B is current...
    expect(result.current.sendFailure).toBeNull();

    // ...but switching BACK to conv-A must still hand the words back. This
    // is the actual #449 guarantee: the record survived the abandonment,
    // it was merely gated, not lost.
    rerender(baseOptions({ surfaceKey: "conv-A", resetKey: "conv-A", stoppedMessageResetKey: "conv-A", fetchImpl }));

    await waitFor(() => expect(result.current.sendFailure).toEqual({ text: "lost text" }));
  });
});

describe("useConversationSurface: overlapping dispatches don't share bookkeeping (#450)", () => {
  it("a late-resolving abandoned dispatch's own acceptance does not clobber a later, still-pending dispatch's failure", async () => {
    // Dispatch A (conv-A) hangs. Dispatch B (conv-B, a DIFFERENT surface --
    // the realistic #450 shape per the review: overlap across a switch, not
    // a same-instance double-click the composer already disables) hangs
    // too, independently. A resolves (accepted) AFTER B has already started
    // -- pre-#450, a SHARED acceptedRef/pendingSendRef would let A's own
    // acceptance incorrectly mark B's still-pending dispatch as accepted
    // too, or clobber B's own pending record outright.
    let resolveA: (() => void) | undefined;
    let rejectB: ((err: unknown) => void) | undefined;
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? String(init.body) : "";
      if (body.includes("from conv-A")) {
        return new Promise<Response>((resolve) => {
          resolveA = () => resolve(new Response("[]", { status: 200 }));
        });
      }
      if (body.includes("from conv-B")) {
        return new Promise<Response>((_resolve, reject) => {
          rejectB = reject;
        });
      }
      return Promise.reject(new Error("unexpected fetch in this test"));
    }) as unknown as typeof fetch;

    const { result, rerender } = renderHook((opts: UseConversationSurfaceOptions) => useConversationSurface(opts), {
      initialProps: baseOptions({ fetchImpl }),
    });

    act(() => {
      result.current.send("from conv-A");
    });
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

    rerender(baseOptions({ surfaceKey: "conv-B", resetKey: "conv-B", stoppedMessageResetKey: "conv-B", fetchImpl }));

    act(() => {
      result.current.send("from conv-B");
    });
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));

    // A's (abandoned) request finally succeeds.
    act(() => {
      resolveA?.();
    });
    await act(async () => {
      await Promise.resolve();
    });

    // B is still genuinely in flight -- A's own acceptance must not have
    // touched B's bookkeeping.
    expect(result.current.sendFailure).toBeNull();

    // Now B itself fails on the send half.
    act(() => {
      rejectB?.(new TypeError("Load failed"));
    });

    // THE PIN: B's own failure must still be recorded correctly, as B's
    // own text -- not silently dropped (as it would be if A's success had
    // already cleared shared bookkeeping B was also relying on) and not
    // misattributed to A's text (as it would be if A's LATE settlement had
    // overwritten a shared pendingSendRef with something read back for B).
    await waitFor(() => expect(result.current.sendFailure).toEqual({ text: "from conv-B" }));
  });
});
