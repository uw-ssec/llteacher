import { afterEach, describe, expect, it, vi } from "vitest";

const { drizzle, poolEnd, poolOn, Pool } = vi.hoisted(() => ({
  drizzle: vi.fn(() => ({ query: {} })),
  poolEnd: vi.fn().mockResolvedValue(undefined),
  poolOn: vi.fn(),
  Pool: vi.fn(),
}));

vi.mock("drizzle-orm/node-postgres", () => ({ drizzle }));
vi.mock("pg", () => ({ Pool }));

import { closeDb, makeDb } from "./client";

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
