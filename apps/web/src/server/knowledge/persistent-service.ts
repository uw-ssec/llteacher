import { promises as fs } from "node:fs";
import path from "node:path";
import {
  digest, encodeManifest, exactArrayBuffer, knowledgeBlobKey, knowledgeManifestKey, KnowledgePersistenceError,
  knowledgeSnapshotKey, MAX_EXPANDED_BYTES, MAX_FILES, parseLegacy, parseManifest,
  readManifestFiles, safeSnapshotPath, type DurableKnowledge, type FileReference,
  type KnowledgeFiles, type KnowledgeManifest,
} from "./persistence-format";
export { knowledgeSnapshotKey } from "./persistence-format";
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
interface CachedFile { stamp: string; reference: FileReference }
type FileCache = Map<string, CachedFile>;

async function collectFiles(base: string, cache: FileCache): Promise<{ manifest: KnowledgeManifest; cache: FileCache; changed: Map<string, Uint8Array> }> {
  const files: Record<string, FileReference> = Object.create(null);
  const next: FileCache = new Map();
  const changed = new Map<string, Uint8Array>();
  let count = 0;
  let expanded = 0;
  async function walk(dir: string, relative: string): Promise<void> {
    const stat = await fs.lstat(dir, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) return;
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Refusing to persist symlink or unsafe directory");
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const name = relative + "/" + entry.name;
      const child = path.join(dir, entry.name);
      const stat = await fs.lstat(child, { bigint: true });
      if (stat.isSymbolicLink()) throw new Error("Refusing to persist symlink");
      if (stat.isDirectory()) { await walk(child, name); continue; }
      if (!stat.isFile() || !safeSnapshotPath(name)) throw new Error("Refusing to persist unsafe file");
      if (++count > MAX_FILES) throw new Error("Knowledge snapshot exceeds the file count limit");
      expanded += Number(stat.size);
      if (expanded > MAX_EXPANDED_BYTES) throw new Error("Knowledge snapshot exceeds the expanded size limit");
      const stamp = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
      let reference = cache.get(name)?.stamp === stamp ? cache.get(name)!.reference : undefined;
      if (!reference) {
        const bytes = new Uint8Array(await fs.readFile(child));
        const after = await fs.lstat(child, { bigint: true });
        if (bytes.byteLength !== Number(stat.size) || [after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs].join(":") !== stamp) throw new Error("Knowledge file changed while snapshotting");
        reference = { sha256: digest(bytes), size: bytes.byteLength };
        changed.set(reference.sha256, bytes);
      }
      files[name] = reference;
      next.set(name, { stamp, reference });
    }
  }
  await walk(path.join(base, "knowledge"), "knowledge");
  await walk(path.join(base, "originals"), "originals");
  return { manifest: { version: 1, files }, cache: next, changed };
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
  private readonly durable = new Map<string, DurableKnowledge>();
  private readonly caches = new Map<string, FileCache>();
  private readonly loaded = new Set<string>();
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

  private async restore(courseId: string, durable: DurableKnowledge): Promise<void> {
    const courseDir = this.courseDir(courseId);
    const files: KnowledgeFiles = durable === null ? {} : "legacy" in durable
      ? await parseLegacy(courseId, durable.legacy)
      : await readManifestFiles(this.storage, courseId, durable.manifest);
    // Validate/download everything before touching the existing local cache.
    // Stage writes so an interrupted restore cannot expose a partial bundle.
    await fs.mkdir(path.dirname(courseDir), { recursive: true });
    const staging = await fs.mkdtemp(courseDir + ".restore-");
    try {
      for (const [relative, bytes] of Object.entries(files)) {
        const target = path.join(staging, ...relative.split("/"));
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, bytes);
      }
      await fs.rm(courseDir, { recursive: true, force: true });
      await fs.rename(staging, courseDir);
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
    this.caches.delete(courseId);
    this.delegates.delete(courseId);
  }

  private async load(courseId: string): Promise<void> {
    const id = this.normalizedCourse(courseId);
    if (this.loaded.has(id)) return;
    if (this.durable.has(id)) {
      await this.restore(id, this.durable.get(id) ?? null);
      this.loaded.add(id);
      return;
    }
    const manifestBody = await this.storage.get(knowledgeManifestKey(id));
    let durable: DurableKnowledge;
    if (manifestBody !== null) {
      durable = { manifest: parseManifest(id, manifestBody) };
    } else {
      const legacy = await this.storage.get(knowledgeSnapshotKey(id));
      durable = legacy === null ? null : { legacy };
    }
    if (durable === null) {
      const entries = await fs.readdir(this.courseDir(id)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      if (entries.length > 0) {
        throw new Error("Knowledge snapshot migration required: remote snapshot is missing while local course files exist; local files were preserved");
      }
    }
    await this.restore(id, durable);
    this.durable.set(id, durable);
    this.loaded.add(id);
  }

  private async persist(courseId: string): Promise<void> {
    const snapshot = await collectFiles(this.courseDir(courseId), this.caches.get(courseId) ?? new Map());
    const previous = this.durable.get(courseId);
    const prior = previous && "manifest" in previous ? previous.manifest : null;
    const body = encodeManifest(snapshot.manifest);
    const known = new Set(Object.values(prior?.files ?? {}).map(file => file.sha256));
    for (const [hash, bytes] of snapshot.changed) {
      if (!known.has(hash)) await this.storage.put(knowledgeBlobKey(courseId, hash), exactArrayBuffer(bytes), { contentType: "application/octet-stream" });
    }
    // Publishing a single object is atomic in S3. Orphaned blobs from failed
    // attempts are intentionally retained; no live or previous data is deleted.
    if (!prior || JSON.stringify(prior) !== JSON.stringify(snapshot.manifest)) {
      await this.storage.put(knowledgeManifestKey(courseId), body, { contentType: "application/json" });
    }
    this.durable.set(courseId, { manifest: snapshot.manifest });
    this.caches.set(courseId, snapshot.cache);
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
          await this.persist(id);
        }
        return result;
      } catch (error) {
        if (mutation) {
          // A failed restore may have already removed or partially rewritten
          // the working tree. Poison loaded state before attempting rollback;
          // only a complete restore may allow another operation to proceed.
          this.loaded.delete(id);
          const durable = this.durable.get(id);
          if (durable === undefined && !this.durable.has(id)) {
            throw new Error("Knowledge durable state is unavailable after a failed mutation", { cause: error });
          }
          await this.restore(id, durable ?? null);
          this.loaded.add(id);
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof KnowledgePersistenceError) {
        console.error(JSON.stringify({ event: "knowledge_persistence_corrupt", code: error.code, courseId: error.courseId, key: error.key }));
      }
      throw error;
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
