import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { memoryObjectStore, type ObjectStore } from "../storage/objectStore";
import { okfAvailable } from "./okfCli";
import {
  PersistentKnowledgeService,
  knowledgeSnapshotKey,
} from "./persistent-service";

const OKF = process.env.OKF_BINARY ?? "okf";
const COURSE_A = "11111111-2222-4333-8444-555555555555";
const COURSE_B = "66666666-7777-4888-8999-000000000000";

function root(): string {
  return mkdtempSync(path.join(tmpdir(), "persistent-kb-"));
}

function service(storage: ObjectStore, knowledgeRoot = root()): PersistentKnowledgeService {
  return new PersistentKnowledgeService({ root: knowledgeRoot, binary: OKF, storage });
}

const create = {
  id: "lesson",
  type: "lecture",
  title: "Lesson",
  description: "A lesson",
  body: "First body",
};

describe.skipIf(!okfAvailable(OKF))("PersistentKnowledgeService (real okf and filesystem)", () => {
  it("fails closed without deleting legacy local knowledge when the remote snapshot is missing", async () => {
    const storage = memoryObjectStore();
    const localRoot = root();
    const file = path.join(localRoot, "courses", COURSE_A, "knowledge", "legacy.md");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "legacy authored body");

    await expect(service(storage, localRoot).list(COURSE_A)).rejects.toThrow(/migration.*snapshot/i);
    expect(readFileSync(file, "utf8")).toBe("legacy authored body");
  });

  it("restores knowledge and the pre-edit original into a fresh root", async () => {
    const storage = memoryObjectStore();
    const first = service(storage);
    await first.create(COURSE_A, create);
    await first.update(COURSE_A, create.id, { body: "Edited body" });

    const restored = await service(storage).show(COURSE_A, create.id);

    expect(restored?.body.trim()).toBe("Edited body");
    expect(restored?.bodyOriginal?.trim()).toBe("First body");
  });

  it("restores deletions and keeps course snapshots isolated", async () => {
    const storage = memoryObjectStore();
    const first = service(storage);
    await first.create(COURSE_A, create);
    await first.remove(COURSE_A, create.id);
    await first.create(COURSE_B, { ...create, body: "Other course" });

    const restarted = service(storage);
    expect(await restarted.show(COURSE_A, create.id)).toBeNull();
    expect((await restarted.show(COURSE_B, create.id))?.body.trim()).toBe("Other course");
  });

  it("rolls back local files when durable upload fails", async () => {
    const backing = memoryObjectStore();
    const initial = service(backing);
    await initial.create(COURSE_A, create);
    let failNextPut = true;
    const failing: ObjectStore = {
      ...backing,
      async put(key, body, opts) {
        if (failNextPut) {
          failNextPut = false;
          throw new Error("storage unavailable");
        }
        await backing.put(key, body, opts);
      },
    };
    const currentRoot = root();
    const current = service(failing, currentRoot);

    await expect(current.update(COURSE_A, create.id, { body: "Unsaved body" })).rejects.toThrow("storage unavailable");
    expect((await current.show(COURSE_A, create.id))?.body.trim()).toBe("First body");
    expect(readFileSync(path.join(currentRoot, "courses", COURSE_A, "knowledge", "lesson.md"), "utf8")).not.toContain("Unsaved body");
    await current.create(COURSE_A, { ...create, id: "second", body: "Saved later" });
    const restarted = service(backing);
    expect((await restarted.show(COURSE_A, create.id))?.body).not.toContain("Unsaved body");
    expect((await restarted.show(COURSE_A, "second"))?.body).toContain("Saved later");
  });

  it("keeps the durable snapshot unchanged when a delegate mutation fails", async () => {
    const storage = memoryObjectStore();
    const svc = service(storage);
    await svc.create(COURSE_A, create);
    await expect(svc.create(COURSE_A, { ...create, body: "must not persist" })).rejects.toThrow();
    const restarted = service(storage);
    expect((await restarted.show(COURSE_A, create.id))?.body.trim()).toBe("First body");
  });

  it("fails closed when the initial snapshot read fails", async () => {
    const storage = memoryObjectStore();
    const localRoot = root();
    const local = service(storage, localRoot);
    await local.create(COURSE_A, create);
    const failing: ObjectStore = {
      ...storage,
      get: async () => { throw new Error("read unavailable"); },
    };

    await expect(service(failing, localRoot).show(COURSE_A, create.id)).rejects.toThrow("read unavailable");
  });

  it("rejects traversal entries without writing outside the course", async () => {
    const storage = memoryObjectStore();
    await storage.put(
      knowledgeSnapshotKey(COURSE_A),
      zipSync({ "../escaped.md": strToU8("bad") }).buffer,
      { contentType: "application/zip" },
    );
    const localRoot = root();

    await expect(service(storage, localRoot).list(COURSE_A)).rejects.toThrow(/unsafe snapshot path/i);
    expect(() => readFileSync(path.join(localRoot, "courses", "escaped.md"))).toThrow();
  });

  it("rejects zip entries marked as symbolic links", async () => {
    const storage = memoryObjectStore();
    const symlinkMode = (0o120777 << 16) >>> 0;
    await storage.put(
      knowledgeSnapshotKey(COURSE_A),
      zipSync({ "knowledge/link.md": [strToU8("target.md"), { os: 3, attrs: symlinkMode }] }).buffer,
      { contentType: "application/zip" },
    );

    await expect(service(storage).list(COURSE_A)).rejects.toThrow(/symbolic link/i);
  });

  it("rejects snapshots whose declared expanded size exceeds the bound", async () => {
    const storage = memoryObjectStore();
    await storage.put(
      knowledgeSnapshotKey(COURSE_A),
      zipSync({ "knowledge/huge.md": new Uint8Array(64 * 1024 * 1024 + 1) }).buffer,
      { contentType: "application/zip" },
    );

    await expect(service(storage).list(COURSE_A)).rejects.toThrow(/expanded size/i);
  });

  it("rejects snapshots over the compressed-size limit", async () => {
    const storage = memoryObjectStore();
    await storage.put(knowledgeSnapshotKey(COURSE_A), new ArrayBuffer(16 * 1024 * 1024 + 1), { contentType: "application/zip" });
    await expect(service(storage).list(COURSE_A)).rejects.toThrow(/compressed size/i);
  });

  it("rejects snapshots over the file-count limit", async () => {
    const storage = memoryObjectStore();
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i <= 10_000; i += 1) files[`knowledge/${i}.md`] = new Uint8Array();
    await storage.put(knowledgeSnapshotKey(COURSE_A), zipSync(files).buffer, { contentType: "application/zip" });
    await expect(service(storage).list(COURSE_A)).rejects.toThrow(/file count/i);
  });

  it("rejects unsafe local files and rolls them back", async () => {
    const storage = memoryObjectStore();
    const localRoot = root();
    const svc = service(storage, localRoot);
    await svc.create(COURSE_A, create);
    const unsafe = path.join(localRoot, "courses", COURSE_A, "knowledge", "unsafe.bin");
    writeFileSync(unsafe, "bad");
    await expect(svc.ensureBundle(COURSE_A)).rejects.toThrow(/unsafe file/i);
    expect(existsSync(unsafe)).toBe(false);
  });

  it("rejects local symlinks and rolls them back", async () => {
    const storage = memoryObjectStore();
    const localRoot = root();
    const svc = service(storage, localRoot);
    await svc.create(COURSE_A, create);
    const link = path.join(localRoot, "courses", COURSE_A, "knowledge", "link.md");
    symlinkSync("lesson.md", link);
    await expect(svc.ensureBundle(COURSE_A)).rejects.toThrow(/symlink/i);
    expect(existsSync(link)).toBe(false);
  });

  it("checks local expanded size before reading an oversized file", async () => {
    const storage = memoryObjectStore();
    const localRoot = root();
    const svc = service(storage, localRoot);
    await svc.create(COURSE_A, create);
    const huge = path.join(localRoot, "courses", COURSE_A, "knowledge", "huge.md");
    mkdirSync(path.dirname(huge), { recursive: true });
    writeFileSync(huge, "");
    truncateSync(huge, 64 * 1024 * 1024 + 1);
    const read = vi.spyOn(fs, "readFile");
    await expect(svc.ensureBundle(COURSE_A)).rejects.toThrow(/expanded size/i);
    expect(read.mock.calls.some(([candidate]) => candidate === huge)).toBe(false);
    read.mockRestore();
  });

  it("serializes reads behind an in-flight mutation for the same course", async () => {
    const backing = memoryObjectStore();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let uploading = false;
    const storage: ObjectStore = {
      ...backing,
      async put(key, body, opts) {
        uploading = true;
        await held;
        await backing.put(key, body, opts);
      },
    };
    const svc = service(storage);
    const creating = svc.create(COURSE_A, create);
    while (!uploading) await new Promise((resolve) => setTimeout(resolve, 1));
    let readFinished = false;
    const reading = svc.show(COURSE_A, create.id).then((value) => { readFinished = true; return value; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(readFinished).toBe(false);
    release();
    await creating;
    expect((await reading)?.body.trim()).toBe("First body");
  });
});
