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
const evalRBoolean = vi.fn().mockResolvedValue(true);
const installPackages = vi.fn().mockResolvedValue(undefined);
const init = vi.fn().mockResolvedValue(undefined);
let webRCtorCalls = 0;

class MockWebR {
  init = init;
  evalRVoid = evalRVoid;
  evalR = evalR;
  evalRBoolean = evalRBoolean;
  installPackages = installPackages;
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
  evalRBoolean.mockClear();
  installPackages.mockClear();
  init.mockResolvedValue(undefined);
  // Default: every package resolves, i.e. a healthy install (#374).
  evalRBoolean.mockResolvedValue(true);
  installPackages.mockResolvedValue(undefined);
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

  /* ---- #374: WASM-binary package installation -------------------------
     The bug this covers was not a crash but a silence: init used to run R's
     own `install.packages()`, which cannot work on a build with no compiler
     toolchain, and swallowed the resulting error per-package. Every test
     here asserts on something that was true-but-invisible before. */

  it("installs DEFAULT_PACKAGES through webR's binary installer, not R's source install.packages()", async () => {
    const useWebR = await importUseWebR();
    const { result } = renderHook(() => useWebR());
    await act(async () => {
      await result.current.ensureReady();
    });

    expect(installPackages).toHaveBeenCalledTimes(1);
    expect(installPackages).toHaveBeenCalledWith(
      ["ggplot2", "dplyr", "tidyr"],
      expect.objectContaining({ repos: "https://repo.r-wasm.org", quiet: true }),
    );
    // The regression itself: nothing may reach R's source installer, which
    // errors with "not set up to install source packages" on this build.
    const evaluated = [...evalR.mock.calls, ...evalRVoid.mock.calls, ...evalRBoolean.mock.calls]
      .map((call) => String(call[0]))
      .join("\n");
    expect(evaluated).not.toContain("install.packages");
  });

  it("verifies each package against R itself and reports none missing when all resolve", async () => {
    const useWebR = await importUseWebR();
    const { result } = renderHook(() => useWebR());
    await act(async () => {
      await result.current.ensureReady();
    });

    expect(evalRBoolean).toHaveBeenCalledWith('isTRUE(requireNamespace("ggplot2", quietly = TRUE))');
    expect(evalRBoolean).toHaveBeenCalledWith('isTRUE(requireNamespace("dplyr", quietly = TRUE))');
    expect(evalRBoolean).toHaveBeenCalledWith('isTRUE(requireNamespace("tidyr", quietly = TRUE))');
    expect(result.current.missingPackages).toEqual([]);
  });

  it("reports a package that does not resolve as missing instead of failing silently", async () => {
    evalRBoolean.mockImplementation((code: string) => Promise.resolve(!code.includes("dplyr")));
    const useWebR = await importUseWebR();
    const { result } = renderHook(() => useWebR());
    await act(async () => {
      await result.current.ensureReady();
    });

    expect(result.current.status).toBe("ready");
    expect(result.current.missingPackages).toEqual(["dplyr"]);
  });

  it("stays usable when the package repo is unreachable, reporting every package missing", async () => {
    installPackages.mockRejectedValueOnce(new Error("repo unreachable"));
    evalRBoolean.mockResolvedValue(false);
    const useWebR = await importUseWebR();
    const { result } = renderHook(() => useWebR());
    await act(async () => {
      await result.current.ensureReady();
    });

    // Best-effort is preserved: R itself still works.
    expect(result.current.status).toBe("ready");
    expect(result.current.error).toBeUndefined();
    expect(result.current.missingPackages).toEqual(["ggplot2", "dplyr", "tidyr"]);
  });

  it("treats a probe that throws as missing rather than letting it fail init", async () => {
    evalRBoolean.mockRejectedValue(new Error("R process gone"));
    const useWebR = await importUseWebR();
    const { result } = renderHook(() => useWebR());
    await act(async () => {
      await result.current.ensureReady();
    });

    expect(result.current.status).toBe("ready");
    expect(result.current.missingPackages).toEqual(["ggplot2", "dplyr", "tidyr"]);
  });

  it("does not report stale missing packages after an init that failed outright", async () => {
    // A failed init learned nothing about package availability -- claiming
    // "dplyr is missing" would be a guess dressed up as a verified fact.
    init.mockRejectedValueOnce(new Error("wasm fetch failed"));
    const useWebR = await importUseWebR();
    const { result } = renderHook(() => useWebR());

    await act(async () => {
      await expect(result.current.ensureReady()).rejects.toThrow();
    });

    expect(result.current.status).toBe("error");
    expect(result.current.missingPackages).toEqual([]);
    // ...and the probe never ran, because init never got that far.
    expect(evalRBoolean).not.toHaveBeenCalled();
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
