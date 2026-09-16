import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, utimesSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { withWriteLock, WriteLockTimeoutError } from "./writeLock";

function lockIn(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "lock-")), ".write.lock");
}

describe("withWriteLock", () => {
  it("serialises two writers and removes the lock afterwards", async () => {
    const lock = lockIn();
    const order: string[] = [];
    const a = withWriteLock(lock, async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 120));
      order.push("a-end");
    });
    const b = withWriteLock(lock, async () => {
      order.push("b");
    });
    await Promise.all([a, b]);
    expect(order).toEqual(["a-start", "a-end", "b"]);
    expect(existsSync(lock)).toBe(false);
  });
  it("times out when another holder never releases", async () => {
    const lock = lockIn();
    writeFileSync(lock, String(process.pid));
    await expect(withWriteLock(lock, async () => 1, { timeoutMs: 200 })).rejects.toBeInstanceOf(
      WriteLockTimeoutError,
    );
  });
  it("steals a stale lock", async () => {
    const lock = lockIn();
    writeFileSync(lock, "dead");
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(lock, old, old);
    expect(await withWriteLock(lock, async () => 42, { staleMs: 60_000 })).toBe(42);
  });
  it("releases the lock when fn throws", async () => {
    const lock = lockIn();
    await expect(withWriteLock(lock, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(existsSync(lock)).toBe(false);
  });
  it("does not remove a lock it no longer owns", async () => {
    const lock = lockIn();
    writeFileSync(lock, "someone-else");
    await expect(withWriteLock(lock, async () => 1, { timeoutMs: 100 })).rejects.toBeInstanceOf(
      WriteLockTimeoutError,
    );
    expect(existsSync(lock)).toBe(true);
    expect(readFileSync(lock, "utf-8")).toBe("someone-else");
  });
  it("the finally path leaves another holder's lock in place after a steal", async () => {
    const lock = lockIn();
    writeFileSync(lock, "dead");
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(lock, old, old);
    expect(
      await withWriteLock(lock, async () => {
        writeFileSync(lock, "other-holder");
        return 1;
      }, { staleMs: 60_000 })
    ).toBe(1);
    expect(existsSync(lock)).toBe(true);
    expect(readFileSync(lock, "utf-8")).toBe("other-holder");
  });
});
