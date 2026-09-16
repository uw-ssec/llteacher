import { describe, it, expect, vi } from "vitest";

const poolCtor = vi.fn();
vi.mock("pg", () => ({
  Pool: class {
    constructor(opts: unknown) {
      poolCtor(opts);
    }
  },
}));

import { makeDb } from "./client";

describe("makeDb", () => {
  it("creates one pg Pool per DATABASE_URL and reuses it", () => {
    makeDb("postgres://a");
    makeDb("postgres://a");
    makeDb("postgres://b");
    expect(poolCtor).toHaveBeenCalledTimes(2);
    expect(poolCtor).toHaveBeenNthCalledWith(1, { connectionString: "postgres://a", max: 10 });
  });
});
