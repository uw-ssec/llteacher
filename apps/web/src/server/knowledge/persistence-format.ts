import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import type { ObjectStore } from "../storage/objectStore";

export const MAX_EXPANDED_BYTES = 64 * 1024 * 1024;
export const MAX_FILES = 10_000;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
export interface FileReference { sha256: string; size: number }
export interface KnowledgeManifest { version: 1; files: Record<string, FileReference> }
export type KnowledgeFiles = Record<string, Uint8Array>;
export type DurableKnowledge = { manifest: KnowledgeManifest } | { legacy: ArrayBuffer } | null;

export function knowledgeManifestKey(courseId: string): string {
  return `courses/${courseId}/knowledge/manifest.json`;
}
export function knowledgeSnapshotKey(courseId: string): string {
  return `courses/${courseId.toLowerCase()}/knowledge/snapshot.zip`;
}
export function knowledgeBlobKey(courseId: string, sha256: string): string {
  return `courses/${courseId}/knowledge/blobs/${sha256}`;
}
export function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
export function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer { return Uint8Array.from(bytes).buffer; }
export function safeSnapshotPath(name: string): boolean {
  if (name.length > 1024 || name.includes("\\") || name.includes("\0")) return false;
  const parts = name.split("/");
  if (parts.some(part => part === "" || part === "." || part === "..")) return false;
  return parts.length > 1 && ((parts[0] === "knowledge" && name.endsWith(".md")) || (parts[0] === "originals" && name.endsWith(".txt")));
}

/** Only identifiers and fixed diagnostics: never include document names/content
 * or raw SDK error messages in operator-facing corruption reports. */
export class KnowledgePersistenceError extends Error {
  constructor(readonly code: "KNOWLEDGE_CORRUPT_MANIFEST" | "KNOWLEDGE_CORRUPT_BLOB" | "KNOWLEDGE_CORRUPT_LEGACY", readonly courseId: string, readonly key: string, reason: string) {
    super(`${code}: ${reason}; course=${courseId}; key=${key}; operator recovery required`);
    this.name = "KnowledgePersistenceError";
  }
}

export function parseManifest(courseId: string, body: ArrayBuffer): KnowledgeManifest {
  const bad = () => new KnowledgePersistenceError("KNOWLEDGE_CORRUPT_MANIFEST", courseId, knowledgeManifestKey(courseId), "invalid manifest");
  if (body.byteLength > MAX_MANIFEST_BYTES) throw bad();
  let value: KnowledgeManifest;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); } catch { throw bad(); }
  if (!value || value.version !== 1 || !value.files || typeof value.files !== "object" || Array.isArray(value.files)) throw bad();
  const entries = Object.entries(value.files);
  if (entries.length > MAX_FILES) throw bad();
  let expanded = 0;
  for (const [name, reference] of entries) {
    if (!safeSnapshotPath(name) || !reference || typeof reference !== "object" || Array.isArray(reference) || typeof reference.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(reference.sha256) || !Number.isSafeInteger(reference.size) || reference.size < 0) throw bad();
    expanded += reference.size;
    if (expanded > MAX_EXPANDED_BYTES) throw bad();
    // A file cannot also be a parent directory.
    for (let slash = name.indexOf("/"); slash >= 0; slash = name.indexOf("/", slash + 1)) {
      if (Object.hasOwn(value.files, name.slice(0, slash))) throw bad();
    }
  }
  return value;
}

export function encodeManifest(manifest: KnowledgeManifest): ArrayBuffer {
  const bytes = new TextEncoder().encode(JSON.stringify(manifest));
  if (bytes.byteLength > MAX_MANIFEST_BYTES) throw new Error("Knowledge manifest exceeds the size limit");
  return bytes.buffer;
}

export async function readManifestFiles(storage: ObjectStore, courseId: string, manifest: KnowledgeManifest): Promise<KnowledgeFiles> {
  const files: KnowledgeFiles = Object.create(null);
  for (const [name, reference] of Object.entries(manifest.files)) {
    const key = knowledgeBlobKey(courseId, reference.sha256);
    // GET failures propagate as transport errors; only missing/invalid bytes
    // are classified as corruption. No fallback to an older or empty state.
    const body = await storage.get(key);
    if (body === null || body.byteLength !== reference.size || digest(new Uint8Array(body)) !== reference.sha256) {
      throw new KnowledgePersistenceError("KNOWLEDGE_CORRUPT_BLOB", courseId, key, "missing blob or checksum mismatch");
    }
    files[name] = new Uint8Array(body);
  }
  return files;
}

/** The legacy decoder runs in a worker, including decompression of small ZIP
 * entries. fflate's callback unzip alone can decompress small files inline. */
export async function parseLegacy(courseId: string, body: ArrayBuffer): Promise<KnowledgeFiles> {
  const fail = (reason: string) => new KnowledgePersistenceError("KNOWLEDGE_CORRUPT_LEGACY", courseId, knowledgeSnapshotKey(courseId), reason);
  if (body.byteLength > 16 * 1024 * 1024) throw fail("compressed size limit");
  const view = new DataView(body);
  let end = -1;
  for (let offset = body.byteLength - 22; offset >= Math.max(0, body.byteLength - 65_557); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === body.byteLength) { end = offset; break; }
  }
  if (end < 0) throw fail("invalid ZIP directory");
  if (end >= 20 && view.getUint32(end - 20, true) === 0x07064b50) throw fail("unsupported ZIP64 directory");
  const count = view.getUint16(end + 10, true);
  if (count > MAX_FILES) throw fail("file count limit");
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || count !== view.getUint16(end + 8, true)) throw fail("unsupported ZIP directory");
  let offset = view.getUint32(end + 16, true);
  if (offset + view.getUint32(end + 12, true) !== end) throw fail("invalid ZIP directory size");
  let expanded = 0;
  const sizes = new Map<string, number>();
  const entries: Array<{ name: string; size: number; start: number; compressed: number; method: number; crc: number }> = [];
  // PKWARE APPNOTE 6.3.10 sections 4.3.7, 4.3.12, 4.3.16 define
  // these local-header, central-directory and end-record byte offsets:
  // https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw fail("invalid ZIP directory");
    if (view.getUint8(offset + 5) === 3 && ((view.getUint32(offset + 38, true) >>> 16) & 0o170000) === 0o120000) throw fail("symbolic link");
    const nameLength = view.getUint16(offset + 28, true);
    const next = offset + 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
    if (next > end) throw fail("invalid ZIP directory");
    const name = new TextDecoder().decode(new Uint8Array(body, offset + 46, nameLength));
    if (!safeSnapshotPath(name) || sizes.has(name)) throw fail("unsafe snapshot path");
    const size = view.getUint32(offset + 24, true);
    const compressed = view.getUint32(offset + 20, true);
    const method = view.getUint16(offset + 10, true);
    const local = view.getUint32(offset + 42, true);
    if (view.getUint16(offset + 8, true) & 1 || (method !== 0 && method !== 8) || local + 30 > body.byteLength || view.getUint32(local, true) !== 0x04034b50) throw fail("invalid ZIP entry");
    const localNameLength = view.getUint16(local + 26, true);
    const start = local + 30 + localNameLength + view.getUint16(local + 28, true);
    if (start + compressed > view.getUint32(end + 16, true) || (method === 0 && compressed !== size) || view.getUint16(local + 8, true) !== method || (view.getUint16(local + 6, true) & 1)) throw fail("invalid ZIP entry");
    if (new TextDecoder().decode(new Uint8Array(body, local + 30, localNameLength)) !== name) throw fail("invalid ZIP entry");
    expanded += size;
    if (expanded > MAX_EXPANDED_BYTES) throw fail("expanded size limit");
    sizes.set(name, size);
    entries.push({ name, size, start, compressed, method, crc: view.getUint32(offset + 16, true) });
    offset = next;
  }
  if (offset !== end) throw fail("invalid ZIP directory count");
  for (const name of sizes.keys()) {
    for (let slash = name.indexOf("/"); slash >= 0; slash = name.indexOf("/", slash + 1)) {
      if (sizes.has(name.slice(0, slash))) throw fail("unsafe snapshot path");
    }
  }
  try {
    const files = await new Promise<KnowledgeFiles>((resolve, reject) => {
      const worker = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        const { inflateRawSync } = require('node:zlib');
        const input = new Uint8Array(workerData.body);
        const table = Array.from({length: 256}, (_, n) => {
          for (let bit = 0; bit < 8; bit++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
          return n >>> 0;
        });
        const files = Object.create(null);
        for (const entry of workerData.entries) {
          const compressed = input.subarray(entry.start, entry.start + entry.compressed);
          // Enforce the output bound during inflation, not after allocation.
          const bytes = entry.method === 0 ? compressed.slice() : inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.size) });
          let crc = 0xffffffff;
          for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
          if (bytes.length !== entry.size || ((crc ^ 0xffffffff) >>> 0) !== entry.crc) throw new Error('Invalid legacy ZIP');
          files[entry.name] = bytes;
        }
        parentPort.postMessage(files);
      `, { eval: true, workerData: { body, entries } });
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", code => { if (code !== 0) reject(new Error("Legacy ZIP worker failed")); });
    });
    if (Object.keys(files).length !== sizes.size || Object.entries(files).some(([name, bytes]) => sizes.get(name) !== bytes.byteLength)) throw fail("invalid ZIP content");
    return files;
  } catch { throw fail("invalid ZIP content"); }
}

export async function zipFiles(files: KnowledgeFiles): Promise<Uint8Array> {
  const modulePath = createRequire(import.meta.url).resolve("fflate");
  return new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const { zipSync } = require(workerData.modulePath);
      parentPort.postMessage(zipSync(workerData.files, { level: 6 }));
    `, { eval: true, workerData: { modulePath, files } });
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", code => { if (code !== 0) reject(new Error("ZIP export worker failed")); });
  });
}
