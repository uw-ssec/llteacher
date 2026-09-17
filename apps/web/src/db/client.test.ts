import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";

const hooks = vi.hoisted(() => ({
  poolCtor: vi.fn(),
  instances: [] as Array<EventEmitter & { end: () => Promise<void> }>,
}));

vi.mock("pg", () => ({
  // An EventEmitter subclass, because the thing under test is an event
  // listener: a plain stub would let makeDb's `pool.on("error", ...)` be a
  // no-op that this file could not tell apart from the bug.
  Pool: class extends EventEmitter {
    end = vi.fn(async () => {});
    constructor(opts: unknown) {
      super();
      hooks.poolCtor(opts);
      hooks.instances.push(this as unknown as EventEmitter & { end: () => Promise<void> });
    }
  },
}));

import { makeDb, closePools } from "./client";

describe("makeDb", () => {
  it("creates one pg Pool per DATABASE_URL and reuses it", () => {
    makeDb("postgres://a");
    makeDb("postgres://a");
    makeDb("postgres://b");
    expect(hooks.poolCtor).toHaveBeenCalledTimes(2);
    expect(hooks.poolCtor).toHaveBeenNthCalledWith(1, { connectionString: "postgres://a", max: 10 });
  });

  // C1 (final review): with no "error" listener, node-postgres' emit on a
  // dead idle client hits EventEmitter's default behaviour and takes the
  // process down. The assertion is on the listener count rather than on a
  // log line because the listener existing at all is the fix.
  it("attaches an error listener to every pool it creates", () => {
    makeDb("postgres://listener");
    const pool = hooks.instances.at(-1)!;
    expect(pool.listenerCount("error")).toBe(1);
    // And emitting does not throw, which is what an unhandled "error" would.
    expect(() => pool.emit("error", new Error("idle client died"))).not.toThrow();
  });

  it("closePools ends every cached pool and forgets it", async () => {
    makeDb("postgres://closing");
    const pool = hooks.instances.at(-1)!;
    await closePools();
    expect(pool.end).toHaveBeenCalledTimes(1);
    // The map is empty again, so the next makeDb builds a fresh pool.
    const before = hooks.poolCtor.mock.calls.length;
    makeDb("postgres://closing");
    expect(hooks.poolCtor.mock.calls.length).toBe(before + 1);
  });
});
