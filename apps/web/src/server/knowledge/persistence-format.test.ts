import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { memoryObjectStore, StorageError } from "../storage/objectStore";
import { encodeManifest, parseLegacy, parseManifest, readManifestFiles } from "./persistence-format";

const course = "11111111-2222-4333-8444-555555555555";
function central(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i <= bytes.length - 4; i++) if (view.getUint32(i, true) === 0x02014b50) return i;
  throw new Error("test archive has no central directory");
}

describe("knowledge persistence format safety", () => {
  it("rejects a forged empty ZIP count instead of silently dropping existing entries", async () => {
    const bytes = zipSync({ "knowledge/lesson.md": strToU8("preserve") });
    const view = new DataView(bytes.buffer);
    const end = bytes.length - 22;
    view.setUint16(end + 8, 0, true);
    view.setUint16(end + 10, 0, true);
    await expect(parseLegacy(course, bytes.buffer)).rejects.toMatchObject({ code: "KNOWLEDGE_CORRUPT_LEGACY" });
  });

  it("rejects a deflate stream larger than its forged central-directory size", async () => {
    const bytes = zipSync({ "knowledge/lesson.md": new Uint8Array(1024 * 1024) });
    new DataView(bytes.buffer).setUint32(central(bytes) + 24, 1, true);
    await expect(parseLegacy(course, bytes.buffer)).rejects.toMatchObject({ code: "KNOWLEDGE_CORRUPT_LEGACY" });
  });

  it("rejects corrupt ZIP bytes even when length and paths are intact", async () => {
    const bytes = zipSync({ "knowledge/lesson.md": [strToU8("original"), { level: 0 }] });
    const view = new DataView(bytes.buffer);
    const start = 30 + view.getUint16(26, true) + view.getUint16(28, true);
    bytes[start] ^= 1;
    await expect(parseLegacy(course, bytes.buffer)).rejects.toMatchObject({ code: "KNOWLEDGE_CORRUPT_LEGACY" });
  });

  it.each([
    { "knowledge/../../escape.md": { sha256: "a".repeat(64), size: 1 } },
    { "knowledge/lesson.md": { sha256: ["a".repeat(64)], size: 1 } },
    { "knowledge/lesson.md": { sha256: "a".repeat(64), size: 64 * 1024 * 1024 + 1 } },
    { "knowledge/a.md": { sha256: "a".repeat(64), size: 1 }, "knowledge/a.md/b.md": { sha256: "a".repeat(64), size: 1 } },
  ])("rejects invalid manifest paths, references and resource limits", files => {
    const body = new TextEncoder().encode(JSON.stringify({ version: 1, files })).buffer;
    expect(() => parseManifest(course, body)).toThrow("KNOWLEDGE_CORRUPT_MANIFEST");
  });

  it("propagates transient GET failure rather than classifying valid knowledge as corrupt", async () => {
    const outage = new StorageError("get", 503);
    const store = { ...memoryObjectStore(), get: async () => { throw outage; } };
    const manifest = parseManifest(course, encodeManifest({ version: 1, files: { "knowledge/a.md": { sha256: "a".repeat(64), size: 1 } } }));
    await expect(readManifestFiles(store, course, manifest)).rejects.toBe(outage);
  });
});
