import { describe, expect, it } from "vitest";
import { memoryObjectStore } from "../storage/objectStore";
import { recoverKnowledge } from "./recovery";
import { digest, encodeManifest, knowledgeBlobKey, knowledgeManifestKey } from "./persistence-format";

const courseId = "11111111-2222-4333-8444-555555555555";
const key = knowledgeManifestKey(courseId);

describe("explicit operator knowledge recovery", () => {
  it("validates a selected version without changing the current manifest by default", async () => {
    const storage = memoryObjectStore();
    const current = new TextEncoder().encode("broken current manifest").buffer;
    await storage.put(key, current, {});
    const selected = encodeManifest({ version: 1, files: {} });
    expect(await recoverKnowledge({ storage, courseId, source: selected, format: "manifest" })).toMatchObject({ applied: false, files: 0 });
    expect(await storage.get(key)).toEqual(current);
  });

  it("preserves the current raw manifest before promoting the selected valid version", async () => {
    const storage = memoryObjectStore();
    const current = new TextEncoder().encode("broken current manifest").buffer;
    await storage.put(key, current, {});
    const bytes = new TextEncoder().encode("prior body");
    const hash = digest(bytes);
    await storage.put(knowledgeBlobKey(courseId, hash), bytes.buffer, {});
    const selected = encodeManifest({ version: 1, files: { "knowledge/lesson.md": { sha256: hash, size: bytes.byteLength } } });
    const result = await recoverKnowledge({ storage, courseId, source: selected, format: "manifest", apply: true });
    expect(result.applied).toBe(true);
    expect(await storage.get(result.backupKey!)).toEqual(current);
    expect(await storage.get(key)).toEqual(selected);
  });

  it("refuses a selected version with missing blobs before any write", async () => {
    const storage = memoryObjectStore();
    const current = encodeManifest({ version: 1, files: {} });
    await storage.put(key, current, {});
    const selected = encodeManifest({ version: 1, files: { "knowledge/lesson.md": { sha256: "a".repeat(64), size: 4 } } });
    await expect(recoverKnowledge({ storage, courseId, source: selected, format: "manifest", apply: true })).rejects.toMatchObject({ code: "KNOWLEDGE_CORRUPT_BLOB" });
    expect(await storage.get(key)).toEqual(current);
  });
});
