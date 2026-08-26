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

  // Code-review follow-up (#28): captureR()'s output items can carry
  // type "message" or "warning" (from R's own message()/warning()) --
  // both were previously silently dropped (matched neither the plain-
  // string stdout/stderr branch nor the error branch). Real risk, not
  // contrived: useWebR.ts installs dplyr/tidyr by default, and dplyr's
  // summarise() emits a message() on every grouped call.
  it("captures an R message() as informational output, in capture order alongside stdout", async () => {
    const shelter = makeShelter(async () => ({
      output: [
        { type: "stdout", data: "before" },
        { type: "message", data: { toString: async () => "`summarise()` has grouped output by 'g'" } },
        { type: "stdout", data: "after" },
      ],
    }));
    ensureReady.mockResolvedValue(makeWebR(shelter));

    const { useRExecution } = await importUseRExecution();
    const { result } = renderHook(() => useRExecution());

    let out!: Awaited<ReturnType<typeof result.current.run>>;
    await act(async () => {
      out = await result.current.run("df |> group_by(g) |> summarise(n())");
    });

    expect(out.status).toBe("success");
    expect(out.output).toBe("before\n`summarise()` has grouped output by 'g'\nafter");
  });

  it("captures an R warning() as output too -- does not flip status to error", async () => {
    const shelter = makeShelter(async () => ({
      output: [{ type: "warning", data: { toString: async () => "NAs introduced by coercion" } }],
    }));
    ensureReady.mockResolvedValue(makeWebR(shelter));

    const { useRExecution } = await importUseRExecution();
    const { result } = renderHook(() => useRExecution());

    let out!: Awaited<ReturnType<typeof result.current.run>>;
    await act(async () => {
      out = await result.current.run("as.numeric('x')");
    });

    expect(out.status).toBe("success");
    expect(out.output).toBe("NAs introduced by coercion");
    expect(out.error).toBeUndefined();
  });

  it("falls back to a generic message/warning label when the condition's own toString is unusable", async () => {
    const shelter = makeShelter(async () => ({
      output: [{ type: "message", data: {} }],
    }));
    ensureReady.mockResolvedValue(makeWebR(shelter));

    const { useRExecution } = await importUseRExecution();
    const { result } = renderHook(() => useRExecution());

    let out!: Awaited<ReturnType<typeof result.current.run>>;
    await act(async () => {
      out = await result.current.run("message('hi')");
    });

    expect(out.status).toBe("success");
    expect(out.output).toBe("An R message occurred during execution");
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

  // Final-review fix wave finding 2: this test used to give hungShelter a
  // `purge` that resolves INSTANTLY (`vi.fn().mockResolvedValue(undefined)`,
  // via makeShelter's default) even while its own captureR is still "hung".
  // That's not physically possible for real WebR -- the worker is
  // single-threaded, so a purge message queued behind a genuinely spinning
  // evaluation cannot be processed until the loop stops, which for `while
  // (TRUE) {}` is never. The old finally block awaited purge() before
  // run() could settle, so this test only passed because its mock was MORE
  // capable than the real dependency it stands in for -- it couldn't have
  // caught the real bug (run() hanging forever on a genuine timeout)
  // because the mock never modeled the one property that caused it.
  //
  // Here hungShelter.purge() is a promise that never resolves either --
  // the honest model of "queued behind a worker that's still occupied by
  // an infinite loop, so this purge might never actually run." This is the
  // regression test for the fix: with the OLD `await shelter.purge()` code,
  // this test would time out/hang, because run() could never settle while
  // purge() never resolves. With the fix (fire-and-forget), run() still
  // settles with the timeout error at the 30s mark regardless.
  it("times out after 30s with a clear message, and the run() promise settles even though the hung shelter's own purge() never resolves", async () => {
    vi.useFakeTimers();
    try {
      // First call: captureR never resolves (simulates an infinite loop) --
      // and neither does purge(), modeling a worker still genuinely occupied
      // by that same spinning evaluation (see this test's own doc comment).
      const hungShelter = {
        captureR: () => new Promise(() => {}),
        purge: vi.fn(() => new Promise(() => {})),
      };
      // Second call: a normal, fast result on a FRESH shelter/instance --
      // this hook always starts a new `Shelter()` per run() (see the call
      // site in useRExecution.ts), so a later call's success never depends
      // on the earlier hung shelter's purge() ever completing.
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
      // The key assertion: `await firstRun` itself resolves. Under the old
      // `await shelter.purge()` code, this line would never resolve at all
      // (a real hang, not just a slow one) because hungShelter.purge() never
      // settles -- fake timers can't unstick a promise that's waiting on
      // nothing but another promise that itself never resolves.
      const timedOut = await firstRun;

      expect(timedOut.status).toBe("error");
      expect(timedOut.error).toContain("Timeout");
      // Fire-and-forget still means purge() was CALLED (best-effort cleanup
      // attempted) -- it's specifically not AWAITED that changed.
      expect(hungShelter.purge).toHaveBeenCalledTimes(1);

      // The hook itself must be usable again -- not stuck in "running" --
      // on a fresh run() call, independent of the still-pending purge()
      // from the hung shelter above.
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
