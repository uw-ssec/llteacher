import { describe, it, expect } from "vitest";
import { withMaterialLock } from "./materialLock";

describe("material lock", () => {
  it("releases a failed operation and treats UUID casing as the same key", async () => {
    let release!: () => void;
    const events: string[] = [];
    const first = withMaterialLock("course-a", "material-a", async () => {
      events.push("first");
      await new Promise<void>((resolve) => { release = resolve; });
      throw new Error("failed write");
    });
    const rejected = expect(first).rejects.toThrow("failed write");
    const second = withMaterialLock("COURSE-A", "MATERIAL-A", async () => { events.push("second"); });
    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toEqual(["first"]);
    release();
    await rejected;
    await second;
    expect(events).toEqual(["first", "second"]);
  });
});
