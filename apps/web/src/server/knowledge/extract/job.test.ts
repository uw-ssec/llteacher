import { describe, it, expect, vi, beforeEach } from "vitest";
import { extractMaterial, scheduleExtraction, pendingExtractions, drainExtractions } from "./job";
import { unsafeCourseScope } from "../../repositories/scope";
import type { ExtractionOutcome } from "./types";

const setMaterialStatus = vi.fn();
const setMaterialDocumentPath = vi.fn();
vi.mock("../../repositories/materials", () => ({
  setMaterialStatus: (...a: unknown[]) => setMaterialStatus(...a),
  setMaterialDocumentPath: (...a: unknown[]) => setMaterialDocumentPath(...a),
}));

/* The queue tests below need an extraction they can hold open; every other
   test in this file needs the real one (they assert on real .md/.txt/.mp3
   outcomes). So `extract` is only overridden when a test opts in by setting
   `hooks.extractOverride`, and falls through to the real implementation
   otherwise. */
const hooks = vi.hoisted(() => ({
  extractOverride: null as null | ((filename: string) => Promise<ExtractionOutcome>),
}));
vi.mock("./index", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./index")>();
  return {
    ...actual,
    extract: (filename: string, bytes: ArrayBuffer) =>
      hooks.extractOverride ? hooks.extractOverride(filename) : actual.extract(filename, bytes),
  };
});

const knowledge = { create: vi.fn(), update: vi.fn(), show: vi.fn() };
const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const base = { db: {} as never, courseId: unsafeCourseScope("c1"), materialId: "m1", knowledge: knowledge as never, existingDocumentPath: null };

beforeEach(() => {
  vi.clearAllMocks();
  hooks.extractOverride = null;
  knowledge.create.mockResolvedValue({ id: "x" });
  knowledge.update.mockResolvedValue({ id: "x" });
});

describe("extractMaterial", () => {
  it("moves pending -> processing -> ready and creates the concept at the derived id", async () => {
    const out = await extractMaterial({ ...base, filename: "Lecture 2.md", relativePath: "Uploaded Lectures/Module 1/Lecture 2.md", bytes: enc("# L2\n\nBody") });
    expect(setMaterialStatus.mock.calls[0]!.slice(2)).toEqual(["m1", "processing", null]);
    expect(knowledge.create).toHaveBeenCalledWith("c1", expect.objectContaining({
      id: "uploaded-lectures/module-1/lecture-2", type: "note", body: "# L2\n\nBody", resource: "llteacher://materials/m1",
    }));
    expect(setMaterialDocumentPath).toHaveBeenCalledWith(expect.anything(), "c1", "m1", "uploaded-lectures/module-1/lecture-2");
    expect(setMaterialStatus.mock.calls.at(-1)!.slice(2)).toEqual(["m1", "ready", null]);
    expect(out).toEqual({ status: "ready", documentPath: "uploaded-lectures/module-1/lecture-2" });
  });
  it("disambiguates a taken id with a numeric suffix", async () => {
    const { ConceptExistsError } = await import("../service");
    knowledge.create.mockRejectedValueOnce(new ConceptExistsError("syllabus")).mockResolvedValueOnce({ id: "syllabus-2" });
    const out = await extractMaterial({ ...base, filename: "syllabus.txt", relativePath: null, bytes: enc("Weeks") });
    expect(knowledge.create.mock.calls[1]![1]).toMatchObject({ id: "syllabus-2" });
    expect(out.documentPath).toBe("syllabus-2");
  });
  it("updates the existing concept on reingest", async () => {
    const out = await extractMaterial({ ...base, filename: "n.txt", relativePath: null, bytes: enc("new"), existingDocumentPath: "n" });
    expect(knowledge.update).toHaveBeenCalledWith("c1", "n", { body: "new" });
    expect(knowledge.create).not.toHaveBeenCalled();
    expect(out).toEqual({ status: "ready", documentPath: "n" });
  });
  it("self-heals a reingest whose concept was deleted: creates a fresh one when update returns null", async () => {
    knowledge.update.mockResolvedValueOnce(null);
    const out = await extractMaterial({ ...base, filename: "syllabus.txt", relativePath: null, bytes: enc("Weeks"), existingDocumentPath: "old-id" });
    expect(knowledge.update).toHaveBeenCalledWith("c1", "old-id", { body: "Weeks" });
    expect(knowledge.create).toHaveBeenCalledWith("c1", expect.objectContaining({ id: "syllabus" }));
    expect(setMaterialDocumentPath).toHaveBeenCalledWith(expect.anything(), "c1", "m1", "syllabus");
    expect(out).toEqual({ status: "ready", documentPath: "syllabus" });
  });
  it("leaves an unsupported format at pending with the reason", async () => {
    const out = await extractMaterial({ ...base, filename: "talk.mp3", relativePath: null, bytes: enc("") });
    expect(setMaterialStatus.mock.calls.at(-1)!.slice(2)).toEqual(["m1", "pending", expect.stringMatching(/not supported/)]);
    expect(knowledge.create).not.toHaveBeenCalled();
    expect(out.status).toBe("pending");
  });
  it("marks failed when the knowledge write throws", async () => {
    knowledge.create.mockRejectedValue(new Error("disk full"));
    const out = await extractMaterial({ ...base, filename: "n.txt", relativePath: null, bytes: enc("x") });
    expect(setMaterialStatus.mock.calls.at(-1)!.slice(2)).toEqual(["m1", "failed", expect.stringContaining("could not be saved")]);
    expect(out.status).toBe("failed");
  });
});

/* I-1 (final review): before the queue, scheduleExtraction was a bare
   setImmediate, so a 500-file folder upload started 500 extractions at once
   -- every one of them holding its upload's bytes in memory. These pin the
   two properties that bound it: at most two run at a time, and the rest
   wait their turn in FIFO order. */
describe("scheduleExtraction queue", () => {
  /** Lets the event loop turn until `ready()` holds, so a test never has to
   *  guess how many microtask layers a job needs to reach its `extract`. */
  async function until(ready: () => boolean): Promise<void> {
    for (let i = 0; i < 200; i++) {
      if (ready()) return;
      await new Promise((r) => setImmediate(r));
    }
    throw new Error("condition never became true");
  }

  function deferredExtract() {
    const started: string[] = [];
    const release: Array<() => void> = [];
    hooks.extractOverride = (filename) => {
      started.push(filename);
      return new Promise<ExtractionOutcome>((resolve) => {
        release.push(() => resolve({ kind: "extracted", type: "note", title: filename, markdown: "body" }));
      });
    };
    return { started, release };
  }

  const enqueue = (name: string) =>
    scheduleExtraction({ ...base, materialId: name, filename: `${name}.txt`, relativePath: null, bytes: enc(name) });

  it("runs two jobs concurrently and holds the third until one finishes", async () => {
    const { started, release } = deferredExtract();
    enqueue("a");
    enqueue("b");
    enqueue("c");
    // Nothing has started yet: enqueueing is synchronous, running is not.
    expect(pendingExtractions()).toBe(3);

    await until(() => started.length >= 2);
    // ...and it stays at two while the third waits for a slot.
    await new Promise((r) => setImmediate(r));
    expect(started).toEqual(["a.txt", "b.txt"]);
    expect(pendingExtractions()).toBe(1);

    release[0]!();
    await until(() => started.length >= 3);
    expect(started).toEqual(["a.txt", "b.txt", "c.txt"]);
    expect(pendingExtractions()).toBe(0);

    release[1]!();
    release[2]!();
    await drainExtractions(2_000);
  });

  it("drainExtractions resolves once the backlog has finished", async () => {
    const { started, release } = deferredExtract();
    enqueue("d");
    enqueue("e");
    await until(() => started.length >= 2);

    let drained = false;
    const draining = drainExtractions(2_000).then(() => {
      drained = true;
    });
    // Still running, so the drain has not resolved.
    await new Promise((r) => setImmediate(r));
    expect(drained).toBe(false);

    release[0]!();
    release[1]!();
    await draining;
    expect(drained).toBe(true);
    expect(pendingExtractions()).toBe(0);
  });

  it("drainExtractions resolves immediately when nothing is queued or running", async () => {
    expect(pendingExtractions()).toBe(0);
    await drainExtractions(2_000);
  });

  it("gives up on a stuck extraction once the timeout passes, rather than blocking shutdown", async () => {
    const { started, release } = deferredExtract();
    enqueue("stuck-1");
    enqueue("stuck-2");
    enqueue("waiting");
    await until(() => started.length >= 2);
    // Two are wedged and a third never got a slot. The drain resolves anyway,
    // on its own deadline, with work still outstanding -- which is the whole
    // point: SIGTERM must not wait on an extraction that will never finish.
    await drainExtractions(20);
    expect(pendingExtractions()).toBe(1);

    // Unwedge them so the module-level queue is empty for whatever runs next.
    for (const releaseOne of release) releaseOne();
    await until(() => started.length >= 3);
    release[2]!();
    await drainExtractions(2_000);
  });
});
