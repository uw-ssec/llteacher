import { promises as fs } from "node:fs";
import path from "node:path";
import { unzipSync, zipSync } from "fflate";
import type { ObjectStore } from "../storage/objectStore";
import {
  ConceptIdError,
  OkfKnowledgeService,
  type Concept,
  type ConceptSummary,
  type CreateConcept,
  type KnowledgeService,
  type SearchHit,
  type ValidationReport,
} from "./service";

const COURSE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_COMPRESSED_BYTES = 16 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 10_000;

export function knowledgeSnapshotKey(courseId: string): string {
  return `courses/${courseId.toLowerCase()}/knowledge/snapshot.zip`;
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function safeSnapshotPath(name: string): boolean {
  if (name === "" || name.includes("\\") || name.startsWith("/") || path.posix.isAbsolute(name)) return false;
  const parts = name.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return false;
  if (parts[0] === "knowledge") return parts.length > 1 && name.endsWith(".md");
  if (parts[0] === "originals") return parts.length > 1 && name.endsWith(".txt");
  return false;
}

function rejectSymlinkEntries(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const firstEocd = Math.max(0, bytes.byteLength - 65_557);
  let eocd = -1;
  for (let offset = bytes.byteLength - 22; offset >= firstEocd; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error("Unsafe knowledge snapshot: invalid zip directory");
  const entries = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("Unsafe knowledge snapshot: invalid zip directory");
    }
    const originOs = view.getUint8(offset + 5);
    const mode = view.getUint32(offset + 38, true) >>> 16;
    if (originOs === 3 && (mode & 0o170000) === 0o120000) {
      throw new Error("Knowledge snapshot contains a symbolic link");
    }
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    offset += 46 + nameLength + extraLength + commentLength;
  }
}

function parseSnapshot(body: ArrayBuffer): Record<string, Uint8Array> {
  if (body.byteLength > MAX_COMPRESSED_BYTES) throw new Error("Knowledge snapshot exceeds the compressed size limit");
  rejectSymlinkEntries(new Uint8Array(body));
  let files = 0;
  let expanded = 0;
  const unzipped = unzipSync(new Uint8Array(body), {
    filter(entry) {
      if (!safeSnapshotPath(entry.name)) throw new Error(`Unsafe snapshot path: ${entry.name}`);
      files += 1;
      expanded += entry.originalSize;
      if (files > MAX_FILES) throw new Error("Knowledge snapshot exceeds the file count limit");
      if (expanded > MAX_EXPANDED_BYTES) throw new Error("Knowledge snapshot exceeds the expanded size limit");
      return true;
    },
  });
  const actualExpanded = Object.values(unzipped).reduce((total, file) => total + file.byteLength, 0);
  if (actualExpanded > MAX_EXPANDED_BYTES) throw new Error("Knowledge snapshot exceeds the expanded size limit");
  return unzipped;
}

async function collectFiles(
  base: string,
  prefix: "knowledge" | "originals",
  extension: ".md" | ".txt",
  out: Record<string, Uint8Array>,
  limits: { files: number; expanded: number },
): Promise<void> {
  const current = path.join(base, prefix);
  async function walk(dir: string, relative: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    })) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const child = path.join(dir, entry.name);
      const stat = await fs.lstat(child);
      if (stat.isSymbolicLink()) throw new Error(`Refusing to persist symlink: ${prefix}/${childRelative}`);
      if (stat.isDirectory()) {
        await walk(child, childRelative);
      } else if (stat.isFile()) {
        if (!entry.name.endsWith(extension)) throw new Error(`Refusing to persist unsafe file: ${prefix}/${childRelative}`);
        limits.files += 1;
        limits.expanded += stat.size;
        if (limits.files > MAX_FILES) throw new Error("Knowledge snapshot exceeds the file count limit");
        if (limits.expanded > MAX_EXPANDED_BYTES) throw new Error("Knowledge snapshot exceeds the expanded size limit");
        const bytes = new Uint8Array(await fs.readFile(child));
        if (bytes.byteLength !== stat.size) throw new Error(`Knowledge file changed while snapshotting: ${prefix}/${childRelative}`);
        out[`${prefix}/${childRelative}`] = bytes;
      } else {
        throw new Error(`Refusing to persist unsafe file: ${prefix}/${childRelative}`);
      }
    }
  }
  await walk(current, "");
}

/**
 * Durable per-course snapshots for the release-one single-task deployment.
 * This serializes operations only inside one process; it is deliberately not
 * safe for multiple writers and relies on ECS stop-before-start deployment.
 */
export class PersistentKnowledgeService implements KnowledgeService {
  private readonly root: string;
  private readonly binary: string;
  private readonly storage: ObjectStore;
  private readonly delegates = new Map<string, OkfKnowledgeService>();
  private readonly durable = new Map<string, ArrayBuffer | null>();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(opts: { root: string; binary: string; storage: ObjectStore }) {
    this.root = opts.root;
    this.binary = opts.binary;
    this.storage = opts.storage;
  }

  private normalizedCourse(courseId: string): string {
    if (!COURSE_ID.test(courseId)) throw new ConceptIdError("Invalid course id");
    return courseId.toLowerCase();
  }

  private courseDir(courseId: string): string {
    return path.join(this.root, "courses", this.normalizedCourse(courseId));
  }

  private delegate(courseId: string): OkfKnowledgeService {
    const id = this.normalizedCourse(courseId);
    let delegate = this.delegates.get(id);
    if (!delegate) {
      delegate = new OkfKnowledgeService({ root: this.root, binary: this.binary });
      this.delegates.set(id, delegate);
    }
    return delegate;
  }

  private async restore(courseId: string, body: ArrayBuffer | null): Promise<void> {
    const courseDir = this.courseDir(courseId);
    const files = body === null ? {} : parseSnapshot(body);
    await fs.rm(courseDir, { recursive: true, force: true });
    await fs.mkdir(courseDir, { recursive: true });
    for (const [relative, bytes] of Object.entries(files)) {
      const target = path.join(courseDir, ...relative.split("/"));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes);
    }
    this.delegates.delete(this.normalizedCourse(courseId));
  }

  private async load(courseId: string): Promise<void> {
    const id = this.normalizedCourse(courseId);
    if (this.durable.has(id)) return;
    const body = await this.storage.get(knowledgeSnapshotKey(id));
    if (body === null) {
      const entries = await fs.readdir(this.courseDir(id)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      if (entries.length > 0) {
        throw new Error("Knowledge snapshot migration required: remote snapshot is missing while local course files exist; local files were preserved");
      }
    }
    await this.restore(id, body);
    this.durable.set(id, body);
  }

  private async snapshot(courseId: string): Promise<ArrayBuffer> {
    const files: Record<string, Uint8Array> = {};
    const limits = { files: 0, expanded: 0 };
    const courseDir = this.courseDir(courseId);
    await collectFiles(courseDir, "knowledge", ".md", files, limits);
    await collectFiles(courseDir, "originals", ".txt", files, limits);
    const zipped = zipSync(files);
    if (zipped.byteLength > MAX_COMPRESSED_BYTES) throw new Error("Knowledge snapshot exceeds the compressed size limit");
    return exactArrayBuffer(zipped);
  }

  private async serialized<T>(courseId: string, mutation: boolean, operation: (service: OkfKnowledgeService) => Promise<T>): Promise<T> {
    const id = this.normalizedCourse(courseId);
    const previous = this.queues.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.queues.set(id, current);
    await previous;
    try {
      await this.load(id);
      try {
        const result = await operation(this.delegate(id));
        if (mutation) {
          const body = await this.snapshot(id);
          await this.storage.put(knowledgeSnapshotKey(id), body, { contentType: "application/zip" });
          this.durable.set(id, body);
        }
        return result;
      } catch (error) {
        if (mutation) await this.restore(id, this.durable.get(id) ?? null);
        throw error;
      }
    } finally {
      release();
      if (this.queues.get(id) === current) this.queues.delete(id);
    }
  }

  ensureBundle(courseId: string): Promise<void> { return this.serialized(courseId, true, (s) => s.ensureBundle(courseId)); }
  list(courseId: string): Promise<ConceptSummary[]> { return this.serialized(courseId, false, (s) => s.list(courseId)); }
  search(courseId: string, query: string, limit?: number, dir?: string): Promise<SearchHit[]> { return this.serialized(courseId, false, (s) => s.search(courseId, query, limit, dir)); }
  show(courseId: string, conceptId: string, opts?: { includeInbound?: boolean }): Promise<Concept | null> { return this.serialized(courseId, false, (s) => s.show(courseId, conceptId, opts)); }
  create(courseId: string, input: CreateConcept): Promise<Concept> { return this.serialized(courseId, true, (s) => s.create(courseId, input)); }
  update(courseId: string, conceptId: string, patch: { body?: string; title?: string; description?: string; expectedBody?: string }): Promise<Concept | null> { return this.serialized(courseId, true, (s) => s.update(courseId, conceptId, patch)); }
  relate(courseId: string, from: string, to: string, context: string): Promise<void> { return this.serialized(courseId, true, (s) => s.relate(courseId, from, to, context)); }
  remove(courseId: string, conceptId: string): Promise<boolean> { return this.serialized(courseId, true, (s) => s.remove(courseId, conceptId)); }
  createDirectory(courseId: string, directory: string): Promise<void> { return this.serialized(courseId, true, (s) => s.createDirectory(courseId, directory)); }
  validate(courseId: string): Promise<ValidationReport> { return this.serialized(courseId, false, (s) => s.validate(courseId)); }
  readRaw(courseId: string, conceptId: string): Promise<string | null> { return this.serialized(courseId, false, (s) => s.readRaw(courseId, conceptId)); }
  removeDirectory(courseId: string, directory: string): Promise<{ removed: string[] } | null> { return this.serialized(courseId, true, (s) => s.removeDirectory(courseId, directory)); }
  removeBundle(courseId: string): Promise<{ removed: number } | null> { return this.serialized(courseId, true, (s) => s.removeBundle(courseId)); }
  exportBundle(courseId: string): Promise<Uint8Array | null> { return this.serialized(courseId, false, (s) => s.exportBundle(courseId)); }
}
