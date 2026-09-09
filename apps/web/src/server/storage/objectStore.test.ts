import { describe, it, expect } from "vitest";
import { materialStorageKey, memoryObjectStore } from "./objectStore";

describe("materialStorageKey", () => {
  it("prefixes by course so deleting a course is a prefix sweep", () => {
    expect(materialStorageKey("c1", "m1", "notes.pdf")).toBe(
      "courses/c1/materials/m1/notes.pdf",
    );
  });

  it("strips path separators from the filename", () => {
    expect(materialStorageKey("c1", "m1", "../../etc/passwd")).toBe(
      "courses/c1/materials/m1/passwd",
    );
  });

  it("falls back to a safe name when the filename is unusable", () => {
    expect(materialStorageKey("c1", "m1", "///")).toBe("courses/c1/materials/m1/upload");
  });
});

describe("memoryObjectStore", () => {
  it("round-trips an object", async () => {
    const store = memoryObjectStore();
    await store.put("k", new TextEncoder().encode("hi").buffer, { contentType: "text/plain" });
    expect(await store.head("k")).toEqual({ key: "k", size: 2, contentType: "text/plain" });
    expect(new TextDecoder().decode((await store.get("k"))!)).toBe("hi");
  });

  it("returns null for a missing key rather than throwing", async () => {
    const store = memoryObjectStore();
    expect(await store.get("nope")).toBeNull();
    expect(await store.head("nope")).toBeNull();
  });

  it("deletes idempotently", async () => {
    const store = memoryObjectStore();
    await store.put("k", new ArrayBuffer(1), {});
    await store.delete("k");
    await store.delete("k");
    expect(await store.head("k")).toBeNull();
  });
});
