// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

/* --------------------------------------------------------------------------
   useWebR — hook unit tests (#28).

   WebR itself is a real ~18MB WASM download (self-hosted, #368/#369 -- see
   useWebR.ts's own doc comment) -- these tests mock the dynamic import (the
   exact module specifier useWebR.ts's computeModuleUrl() resolves to at
   runtime) rather than exercising the real module, per the issue's own
   Testing Strategy ("Not worth testing: WebR WASM compilation itself...
   trust the module works"). The mock target is the same-origin URL
   computeModuleUrl() builds from window.location.origin -- jsdom's default
   test origin is http://localhost:3000 (verified, not assumed), so that's
   the literal string vi.doMock needs; if this test environment's configured
   URL ever changes, this mock target must move with it.

   useWebR's init state is a MODULE-LEVEL singleton (by design -- see its
   own doc comment), so every test needs a fresh module instance or it would
   see whatever the PREVIOUS test left the singleton in. `vi.resetModules()`
   + a fresh dynamic `import("./useWebR")` per test achieves that without
   exposing a test-only reset export from production code.
   -------------------------------------------------------------------------- */

const evalRVoid = vi.fn().mockResolvedValue(undefined);
const evalR = vi.fn().mockResolvedValue(undefined);
const init = vi.fn().mockResolvedValue(undefined);
let webRCtorCalls = 0;

class MockWebR {
  init = init;
  evalRVoid = evalRVoid;
  evalR = evalR;
  Shelter = class {};
  constructor() {
    webRCtorCalls += 1;
  }
}

beforeEach(() => {
  vi.resetModules();
  webRCtorCalls = 0;
  init.mockClear();
  evalRVoid.mockClear();
  evalR.mockClear();
  init.mockResolvedValue(undefined);
  vi.doMock("http://localhost:3000/webr/webr.js", () => ({ WebR: MockWebR }));
});

afterEach(() => {
  vi.doUnmock("http://localhost:3000/webr/webr.js");
});

async function importUseWebR() {
  const mod = await import("./useWebR");
  return mod.useWebR;
}

describe("useWebR", () => {
  it("starts idle and never auto-initializes on mount", async () => {
    const useWebR = await importUseWebR();
    renderHook(() => useWebR());
    // Give any accidental init-on-mount effect a tick to fire.
    await new Promise((r) => setTimeout(r, 0));
    expect(webRCtorCalls).toBe(0);
    expect(init).not.toHaveBeenCalled();
  });

  it("transitions idle -> loading -> ready on ensureReady()", async () => {
    const useWebR = await importUseWebR();
    const { result } = renderHook(() => useWebR());
    expect(result.current.status).toBe("idle");

    let readyPromise!: Promise<unknown>;
    act(() => {
      readyPromise = result.current.ensureReady();
    });
    expect(result.current.status).toBe("loading");

    await act(async () => {
      await readyPromise;
    });
    expect(result.current.status).toBe("ready");
    expect(result.current.error).toBeUndefined();
  });

  it("sets webr::canvas as the default graphics device during init", async () => {
    const useWebR = await importUseWebR();
    const { result } = renderHook(() => useWebR());
    await act(async () => {
      await result.current.ensureReady();
    });
    expect(evalRVoid).toHaveBeenCalledWith("options(device=webr::canvas)");
  });

  it("surfaces an init failure as status 'error' with a message", async () => {
    init.mockRejectedValueOnce(new Error("network blocked"));
    const useWebR = await importUseWebR();
    const { result } = renderHook(() => useWebR());

    await act(async () => {
      await expect(result.current.ensureReady()).rejects.toThrow("network blocked");
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("network blocked");
  });

  it("recovers from a failed init on a later ensureReady() call (not pinned forever)", async () => {
    init.mockRejectedValueOnce(new Error("transient failure"));
    const useWebR = await importUseWebR();
    const { result } = renderHook(() => useWebR());

    await act(async () => {
      await expect(result.current.ensureReady()).rejects.toThrow();
    });
    expect(result.current.status).toBe("error");

    // Second attempt succeeds (init's mock rejects only once).
    await act(async () => {
      await result.current.ensureReady();
    });
    expect(result.current.status).toBe("ready");
  });

  it("initializes the WebR instance exactly once across multiple hook instances calling ensureReady concurrently (no race)", async () => {
    const useWebR = await importUseWebR();
    const first = renderHook(() => useWebR());
    const second = renderHook(() => useWebR());

    await act(async () => {
      await Promise.all([first.result.current.ensureReady(), second.result.current.ensureReady()]);
    });

    expect(webRCtorCalls).toBe(1);
    expect(init).toHaveBeenCalledTimes(1);
    expect(first.result.current.status).toBe("ready");
    expect(second.result.current.status).toBe("ready");
  });

  it("initializes exactly once across sequential calls too (second call reuses the ready instance)", async () => {
    const useWebR = await importUseWebR();
    const { result } = renderHook(() => useWebR());

    await act(async () => {
      await result.current.ensureReady();
    });
    await act(async () => {
      await result.current.ensureReady();
    });

    expect(webRCtorCalls).toBe(1);
    expect(init).toHaveBeenCalledTimes(1);
  });

  it("a hook instance mounted after another already completed init starts out ready", async () => {
    const useWebR = await importUseWebR();
    const first = renderHook(() => useWebR());
    await act(async () => {
      await first.result.current.ensureReady();
    });

    const second = renderHook(() => useWebR());
    await waitFor(() => expect(second.result.current.status).toBe("ready"));
    // Mounting a second component must not re-trigger init.
    expect(webRCtorCalls).toBe(1);
  });
});
