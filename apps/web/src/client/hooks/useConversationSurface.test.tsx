// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useConversationSurface, type UseConversationSurfaceOptions } from "./useConversationSurface";

/* #420 review, Minor #5: the Critical fix's `hasSendFailure` ungating (used
   by `errorRow`'s `stage`/`onRetry` derivation, see that hook's own doc
   comment) had no test that would fail if it were REVERTED to the
   key-gated `sendFailure` while `clearError()` stayed in place -- the
   existing App-level `#420` test only asserts "no alert renders", which
   `clearError()` alone (successfully flipping the real useChat status out
   of "error") already satisfies, with or without the classification fix.

   This isolates the classification itself: `@ai-sdk/react`'s `useChat` is
   replaced with a fully-controlled stub whose `clearError` is a no-op --
   `status` therefore stays "error" across a switch REGARDLESS of whether
   the resetKey-keyed effect calls `clearError`, which is exactly the
   "some future render where status is still 'error' for a beat" case
   `hasSendFailure`'s own doc comment calls out as what it defends against
   even when clearError itself is doing its job. If `stage`/`onRetry` were
   ever changed back to reading the key-gated `sendFailure` instead of the
   ungated `hasSendFailure`, this test would catch it: `sendFailure` is
   null after the switch (correctly gated), so a reverted classification
   would report `stage: "response"` and a live `onRetry` here instead of
   the required `stage: "send"` / `onRetry: undefined`. */

const clearErrorMock = vi.fn();
const chatState: { status: "submitted" | "streaming" | "ready" | "error"; error: Error | undefined } = {
  status: "ready",
  error: undefined,
};

vi.mock("@ai-sdk/react", () => ({
  useChat: () => ({
    messages: [],
    setMessages: vi.fn(),
    sendMessage: vi.fn(),
    status: chatState.status,
    error: chatState.error,
    regenerate: vi.fn(),
    // Deliberately the SAME stable reference every render (mirrors real
    // useChat's own stability, per useConversationSurface's own comment on
    // why the resetKey-keyed effect depends on it) -- a fresh vi.fn() per
    // render here would make that effect re-fire on every unrelated render
    // too, rather than only on a genuine resetKey change.
    clearError: clearErrorMock,
    stop: vi.fn(),
  }),
}));

afterEach(() => {
  cleanup();
  chatState.status = "ready";
  chatState.error = undefined;
});

describe("useConversationSurface: hasSendFailure classification (#420 review, Minor #5)", () => {
  it("classifies a stale send-half failure as stage 'send' with no onRetry after a switch, even when clearError is a no-op", () => {
    const baseOptions: UseConversationSurfaceOptions = {
      surfaceKey: "section-1",
      resetKey: "section-1",
      stoppedMessageResetKey: "section-1",
      initialMessages: [],
      fetchImpl: vi.fn() as unknown as typeof fetch,
      buildSendBody: () => ({}),
      buildRetryBody: () => ({}),
      hydrationError: null,
    };

    const { result, rerender } = renderHook((opts: UseConversationSurfaceOptions) => useConversationSurface(opts), {
      initialProps: baseOptions,
    });

    // A send is dispatched under "section-1"...
    act(() => {
      result.current.send("doomed question");
    });

    // ...and fails before the server ever answered it (send-half failure:
    // `acceptedRef` is still false from `send` above).
    chatState.status = "error";
    rerender({ ...baseOptions });

    // Baseline: the failure-detection effect ran and recorded a send-half
    // failure gated to "section-1" -- both the gated and ungated views
    // agree here, since nothing has switched away yet.
    expect(result.current.sendFailure).toEqual({ text: "doomed question" });
    expect(result.current.errorRow?.stage).toBe("send");
    expect(result.current.errorRow?.onRetry).toBeUndefined();

    // The student switches to "section-2". The resetKey-keyed effect calls
    // clearError() -- but it's a no-op stub here, so `status` stays
    // "error" exactly as if the real clearError's effect hadn't landed
    // yet, isolating this test from whether clearError itself works.
    rerender({
      ...baseOptions,
      resetKey: "section-2",
      surfaceKey: "section-2",
      stoppedMessageResetKey: "section-2",
    });

    expect(clearErrorMock).toHaveBeenCalled();
    // The gated view (composer restore) correctly sees nothing: this
    // failure belongs to "section-1", not the current "section-2".
    expect(result.current.sendFailure).toBeNull();
    // THE PIN: despite `sendFailure` now being null, `errorRow` must still
    // classify this as a send-half failure (via the UNGATED
    // `hasSendFailure`) -- not "response" with a live Retry, which is
    // exactly the cross-surface regeneration hazard #420 fixed.
    expect(result.current.errorRow?.stage).toBe("send");
    expect(result.current.errorRow?.onRetry).toBeUndefined();
  });
});
