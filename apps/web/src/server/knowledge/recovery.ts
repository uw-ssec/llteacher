import { randomUUID } from "node:crypto";
import type { ObjectStore } from "../storage/objectStore";
import {
  digest, encodeManifest, exactArrayBuffer, knowledgeBlobKey, knowledgeManifestKey,
  parseLegacy, parseManifest, readManifestFiles, type KnowledgeManifest,
} from "./persistence-format";

/** Offline operator workflow. Caller must stop every writer and, for S3,
 * condition publication on the current object's ETag. Never deletes objects. */
export async function recoverKnowledge(opts: {
  storage: ObjectStore; courseId: string; source: ArrayBuffer;
  format: "manifest" | "legacy"; apply?: boolean;
}): Promise<{ applied: boolean; files: number; backupKey?: string }> {
  const { storage, source, format } = opts;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(opts.courseId)) throw new Error("Invalid course id");
  const courseId = opts.courseId.toLowerCase();
  const files = format === "legacy" ? await parseLegacy(courseId, source)
    : await readManifestFiles(storage, courseId, parseManifest(courseId, source));
  const manifest: KnowledgeManifest = { version: 1, files: Object.create(null) };
  for (const [name, bytes] of Object.entries(files)) manifest.files[name] = { sha256: digest(bytes), size: bytes.byteLength };
  const body = encodeManifest(manifest);
  if (!opts.apply) return { applied: false, files: Object.keys(files).length };
  const key = knowledgeManifestKey(courseId);
  const current = await storage.get(key);
  const backupKey = current === null ? undefined : `courses/${courseId}/knowledge/recovery/${randomUUID()}.json`;
  if (backupKey && current !== null) await storage.put(backupKey, current, { contentType: "application/json" });
  if (format === "legacy") {
    for (const [name, bytes] of Object.entries(files)) {
      const blobKey = knowledgeBlobKey(courseId, manifest.files[name].sha256);
      const existing = await storage.get(blobKey);
      if (existing !== null) {
        if (digest(new Uint8Array(existing)) !== manifest.files[name].sha256) throw new Error("Existing immutable blob is corrupt; restore its explicit S3 version before retrying recovery");
      } else {
        await storage.put(blobKey, exactArrayBuffer(bytes), { contentType: "application/octet-stream" });
      }
    }
  }
  await storage.put(key, body, { contentType: "application/json" });
  return { applied: true, files: Object.keys(files).length, backupKey };
}
