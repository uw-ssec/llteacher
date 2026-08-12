import { describe, it, expect, vi } from "vitest";
import { runAtomically } from "./atomic";
import type { Db } from "../../db/client";

describe("runAtomically", () => {
  it("uses db.batch when the driver provides it (production/neon-http)", async () => {
    const batch = vi.fn().mockResolvedValue(undefined);
    const transaction = vi.fn();
    const db = { batch, transaction } as unknown as Db;

    await runAtomically(db, () => ["s1", "s2"] as never[]);

    expect(batch).toHaveBeenCalledWith(["s1", "s2"]);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("falls back to db.transaction when batch is absent (tests/node-postgres)", async () => {
    const handles: unknown[] = [];
    const transaction = vi.fn(async (fn: (tx: Db) => Promise<void>) => {
      await fn({ marker: "tx" } as unknown as Db);
    });
    const db = { transaction } as unknown as Db;

    await runAtomically(db, (t) => {
      handles.push(t);
      return [Promise.resolve("a"), Promise.resolve("b")] as never[];
    });

    expect(transaction).toHaveBeenCalled();
    // build() must receive the transaction handle, not the outer db --
    // otherwise every statement it constructs runs outside the transaction
    // and the "all-or-nothing" guarantee is a comment rather than a fact.
    expect(handles).toEqual([{ marker: "tx" }]);
  });

  it("does not open a batch when there is nothing to write", async () => {
    const batch = vi.fn();
    await runAtomically({ batch } as unknown as Db, () => []);
    expect(batch).not.toHaveBeenCalled();
  });
});
