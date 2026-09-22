import { afterEach, describe, expect, it, vi } from "vitest";

const { drizzle, poolEnd, poolOn, Pool } = vi.hoisted(() => ({
  drizzle: vi.fn(() => ({ query: {} })),
  poolEnd: vi.fn().mockResolvedValue(undefined),
  poolOn: vi.fn(),
  Pool: vi.fn(),
}));

vi.mock("drizzle-orm/node-postgres", () => ({ drizzle }));
vi.mock("pg", () => ({ Pool }));

import { closeDb, makeDb, withSessionAdvisoryLock } from "./client";

afterEach(async () => {
  await closeDb();
  Pool.mockReset();
  poolOn.mockReset();
  poolEnd.mockReset();
  poolEnd.mockResolvedValue(undefined);
  drizzle.mockClear();
});

describe("makeDb", () => {
  it("keeps idle pool errors from becoming uncaught process errors", () => {
    Pool.mockImplementation(() => ({ end: poolEnd, on: poolOn }));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    makeDb("postgres://user:secret@db.example/llteacher");

    const idleErrorHandler = poolOn.mock.calls.find(([event]) => event === "error")?.[1];
    expect(idleErrorHandler).toEqual(expect.any(Function));
    expect(() => idleErrorHandler(new Error("password=secret connection lost"))).not.toThrow();
    expect(errorLog).toHaveBeenCalledWith("PostgreSQL pool idle client error");

    errorLog.mockRestore();
  });
});

describe("withSessionAdvisoryLock", () => {
  it("runs work and unlocks on the same checked-out connection", async () => {
    const events: string[] = [];
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        events.push(`${sql}:${values?.[0] ?? ""}`);
        return sql.includes("pg_try_advisory_lock") ? { rows: [{ acquired: true }] } : { rows: [] };
      }),
      release: vi.fn(() => { events.push("release"); }),
    };
    Pool.mockImplementation(() => ({ connect: async () => client, end: poolEnd, on: poolOn }));
    makeDb("postgres://db/llteacher");

    const result = await withSessionAdvisoryLock(0x4c4c5453, async () => {
      events.push("work");
      return "complete";
    });

    expect(result).toEqual({ acquired: true, value: "complete" });
    expect(events).toEqual([
      "SELECT pg_try_advisory_lock($1) AS acquired:1280070739",
      "work",
      "SELECT pg_advisory_unlock($1):1280070739",
      "release",
    ]);
  });

  it("does not run work when another session owns the lock", async () => {
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [{ acquired: false }] }),
      release: vi.fn(),
    };
    Pool.mockImplementation(() => ({ connect: async () => client, end: poolEnd, on: poolOn }));
    makeDb("postgres://db/llteacher");
    const work = vi.fn();

    await expect(withSessionAdvisoryLock(7, work)).resolves.toEqual({ acquired: false });
    expect(work).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledOnce();
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("unlocks and releases the session when work throws", async () => {
    const client = {
      query: vi.fn().mockResolvedValueOnce({ rows: [{ acquired: true }] }).mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    };
    Pool.mockImplementation(() => ({ connect: async () => client, end: poolEnd, on: poolOn }));
    makeDb("postgres://db/llteacher");

    await expect(withSessionAdvisoryLock(9, async () => { throw new Error("sweep failed"); }))
      .rejects.toThrow("sweep failed");
    expect(client.query).toHaveBeenNthCalledWith(2, "SELECT pg_advisory_unlock($1)", [9]);
    expect(client.release).toHaveBeenCalledOnce();
  });
});
