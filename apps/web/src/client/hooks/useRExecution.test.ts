// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

/* --------------------------------------------------------------------------
   useRExecution — hook unit tests (#28).

   Mocks useWebR entirely (not the WebR CDN module -- see useWebR.test.ts
   for that layer) so these tests focus on this hook's own job: turning a
   captureR() result into an RCodeResult, enforcing the 30s timeout, and
   recovering cleanly afterward. A fake `Shelter`/`captureR` stands in for
   the real WebR instance.
   -------------------------------------------------------------------------- */

const ensureReady = vi.fn();
const useWebRMock = vi.fn(() => ({ status: "ready" as const, error: undefined, ensureReady }));

vi.mock("./useWebR", () => ({
  useWebR: () => useWebRMock(),
}));

function makeShelter(captureR: (code: string) => Promise<unknown>) {
  const purge = vi.fn().mockResolvedValue(undefined);
  return { captureR, purge };
}

function makeWebR(shelter: ReturnType<typeof makeShelter>) {
  // Mirrors the real WebR API's `new webR.Shelter()` -- a class whose
  // constructor returns the pre-built fake shelter instead of `this`
  // (valid JS: a constructor returning an object overrides the `new`
  // result), so `await new webR.Shelter()` in useRExecution.ts resolves to
  // exactly the fake this test controls.
  function ShelterCtor(this: unknown) {
    return shelter;
  }
  return { Shelter: ShelterCtor as unknown as new () => ReturnType<typeof makeShelter> };
}

beforeEach(() => {
  ensureReady.mockReset();
  useWebRMock.mockReset();
  useWebRMock.mockReturnValue({ status: "ready", error: undefined, ensureReady });
});

async function importUseRExecution() {
  const mod = await import("./useRExecution");
  return mod;
}

describe("useRExecution", () => {
  it("captures multiline stdout output without truncation or reordering", async () => {
    const shelter = makeShelter(async () => ({
      output: [
        { type: "stdout", data: "line 1" },
        { type: "stdout", data: "line 2" },
        { type: "stderr", data: "a warning" },
        { type: "stdout", data: "line 3" },
      ],
    }));
    ensureReady.mockResolvedValue(makeWebR(shelter));

    const { useRExecution } = await importUseRExecution();
    const { result } = renderHook(() => useRExecution());

    let out!: Awaited<ReturnType<typeof result.current.run>>;
    await act(async () => {
      out = await result.current.run("cat('line 1\\n'); cat('line 2\\n')");
    });

    expect(out.status).toBe("success");
    expect(out.output).toBe("line 1\nline 2\na warning\nline 3");
    expect(shelter.purge).toHaveBeenCalledTimes(1);
  });

  it("captures an R error distinctly, alongside whatever stdout came before it", async () => {
    const shelter = makeShelter(async () => ({
      output: [
        { type: "stdout", data: "before the error" },
        { type: "error", data: { toString: async () => "object 'x' not found" } },
      ],
    }));
    ensureReady.mockResolvedValue(makeWebR(shelter));

    const { useRExecution } = await importUseRExecution();
    const { result } = renderHook(() => useRExecution());

    let out!: Awaited<ReturnType<typeof result.current.run>>;
    await act(async () => {
      out = await result.current.run("x + 1");
    });

    expect(out.status).toBe("error");
    expect(out.error).toBe("object 'x' not found");
    expect(out.output).toBe("before the error");
  });

  it("falls back to the last expression's own printed value when nothing was explicitly output", async () => {
    const shelter = makeShelter(async () => ({
      output: [],
      result: { toString: async () => "[1] 47" },
    }));
    ensureReady.mockResolvedValue(makeWebR(shelter));

    const { useRExecution } = await importUseRExecution();
    const { result } = renderHook(() => useRExecution());

    let out!: Awaited<ReturnType<typeof result.current.run>>;
    await act(async () => {
      out = await result.current.run("6 * 7 + 5");
    });

    expect(out.status).toBe("success");
    expect(out.output).toBe("[1] 47");
  });

  it("captures plot images from the shelter result", async () => {
    const fakeBitmap = {} as ImageBitmap;
    const shelter = makeShelter(async () => ({ output: [], images: [fakeBitmap] }));
    ensureReady.mockResolvedValue(makeWebR(shelter));

    const { useRExecution } = await importUseRExecution();
    const { result } = renderHook(() => useRExecution());

    let out!: Awaited<ReturnType<typeof result.current.run>>;
    await act(async () => {
      out = await result.current.run("plot(1:10)");
    });

    expect(out.images).toEqual([fakeBitmap]);
  });

  it("resolves with a clear error (never rejects) when WebR fails to load", async () => {
    ensureReady.mockRejectedValue(new Error("network blocked"));

    const { useRExecution } = await importUseRExecution();
    const { result } = renderHook(() => useRExecution());

    let out!: Awaited<ReturnType<typeof result.current.run>>;
    await act(async () => {
      out = await result.current.run("1 + 1");
    });

    expect(out.status).toBe("error");
    expect(out.error).toContain("network blocked");
  });

  it("times out after 30s with a clear message, and the next call still succeeds (instance recovers)", async () => {
    vi.useFakeTimers();
    try {
      // First call: captureR never resolves (simulates an infinite loop).
      const hungShelter = makeShelter(() => new Promise(() => {}));
      // Second call: a normal, fast result.
      const healthyShelter = makeShelter(async () => ({ output: [{ type: "stdout", data: "ok" }] }));
      ensureReady.mockResolvedValueOnce(makeWebR(hungShelter)).mockResolvedValueOnce(makeWebR(healthyShelter));

      const { useRExecution, R_EXECUTION_TIMEOUT_MS } = await importUseRExecution();
      const { result } = renderHook(() => useRExecution());

      let firstRun!: Promise<Awaited<ReturnType<typeof result.current.run>>>;
      act(() => {
        firstRun = result.current.run("while (TRUE) {}");
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(R_EXECUTION_TIMEOUT_MS);
      });
      const timedOut = await firstRun;

      expect(timedOut.status).toBe("error");
      expect(timedOut.error).toContain("Timeout");
      expect(hungShelter.purge).toHaveBeenCalledTimes(1);

      // The hook itself must be usable again -- not stuck in "running".
      let second!: Awaited<ReturnType<typeof result.current.run>>;
      await act(async () => {
        second = await result.current.run("cat('ok')");
      });
      expect(second.status).toBe("success");
      expect(second.output).toBe("ok");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports isRunning true only while a run is in flight", async () => {
    let resolveCapture!: (v: unknown) => void;
    const shelter = makeShelter(() => new Promise((resolve) => { resolveCapture = resolve; }));
    ensureReady.mockResolvedValue(makeWebR(shelter));

    const { useRExecution } = await importUseRExecution();
    const { result } = renderHook(() => useRExecution());

    expect(result.current.isRunning).toBe(false);

    let runPromise!: Promise<unknown>;
    act(() => {
      runPromise = result.current.run("Sys.sleep(1)");
    });
    // Let the run() microtask chain reach captureR() (through ensureReady's
    // own resolved promise) before asserting the in-flight state or using
    // resolveCapture, which the captureR promise executor only assigns once
    // that point is reached.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.isRunning).toBe(true);

    await act(async () => {
      resolveCapture({ output: [] });
      await runPromise;
    });
    expect(result.current.isRunning).toBe(false);
  });
});
