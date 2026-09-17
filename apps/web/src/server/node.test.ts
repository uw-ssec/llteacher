import { describe, it, expect, vi, afterEach } from "vitest";
import { envFromProcess, installShutdownHandlers } from "./node";

const FULL = {
  DATABASE_URL: "postgres://x", WORKOS_API_KEY: "k", WORKOS_CLIENT_ID: "c",
  OPENROUTER_API_KEY: "o", LLMOXIE_API_KEY: "l", SESSION_SECRET: "s",
  ENCRYPTION_KEY: "e", BLIND_INDEX_KEY: "b", WORKOS_WEBHOOK_SECRET: "w",
  STORAGE_ENDPOINT: "http://s3", STORAGE_BUCKET: "bkt", STORAGE_ACCESS_KEY_ID: "a",
  STORAGE_SECRET_ACCESS_KEY: "z", KNOWLEDGE_ROOT: "/tmp/k",
};

describe("envFromProcess", () => {
  it("builds an Env with a 404 ASSETS stub", async () => {
    const env = envFromProcess(FULL);
    expect(env.KNOWLEDGE_ROOT).toBe("/tmp/k");
    const res = await env.ASSETS.fetch(new Request("http://x/"));
    expect(res.status).toBe(404);
  });
  it("names every missing variable", () => {
    const { KNOWLEDGE_ROOT: _omit, ...partial } = FULL;
    expect(() => envFromProcess(partial)).toThrow(/KNOWLEDGE_ROOT/);
  });
});

/* I-4 (final review): without this, SIGTERM hit Node's default handler and
   the process died mid-extraction with the server still accepting
   connections. `process.exit` is mocked, so the handler runs to completion
   here instead of taking the test runner with it. */
describe("installShutdownHandlers", () => {
  const added: Array<[NodeJS.Signals, NodeJS.SignalsListener]> = [];

  function install(server: { close: () => void }) {
    const before = {
      SIGTERM: new Set(process.listeners("SIGTERM")),
      SIGINT: new Set(process.listeners("SIGINT")),
    };
    installShutdownHandlers(server);
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      for (const listener of process.listeners(signal)) {
        if (!before[signal].has(listener)) added.push([signal, listener as NodeJS.SignalsListener]);
      }
    }
  }

  afterEach(() => {
    // Leaving a handler installed would make the NEXT test in this file
    // receive signals meant for nobody.
    for (const [signal, listener] of added.splice(0)) process.off(signal, listener);
    vi.restoreAllMocks();
  });

  it("stops the server and exits 0 once the drain finishes", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const close = vi.fn();
    install({ close });

    process.emit("SIGTERM");
    // The listening socket closes synchronously; the exit waits on the drain.
    expect(close).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });

  it("exits immediately on a second signal rather than starting a second drain", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const close = vi.fn();
    install({ close });

    process.emit("SIGINT");
    process.emit("SIGINT");
    // The second signal short-circuits: it exits without closing again.
    expect(exit).toHaveBeenCalledWith(0);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
