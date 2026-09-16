import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { okfAvailable } from "./okfCli";
import { OkfKnowledgeService, ConceptIdError, ConceptExistsError } from "./service";

const OKF = process.env.OKF_BINARY ?? "okf";
const COURSE_A = "11111111-2222-4333-8444-555555555555";
const COURSE_B = "66666666-7777-4888-8999-000000000000";

describe.skipIf(!okfAvailable(OKF))("OkfKnowledgeService (real binary)", () => {
  let svc: OkfKnowledgeService;
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "kb-"));
    svc = new OkfKnowledgeService({ root, binary: OKF });
  });

  it("creates a concept with app frontmatter and okf bookkeeping", async () => {
    const created = await svc.create(COURSE_A, {
      id: "lectures/module-1/intro",
      type: "lecture",
      title: "Intro to supply and demand",
      description: "Lecture 1: markets",
      body: "# Intro\n\nSupply and demand set the equilibrium price.",
      resource: "llteacher://materials/m-1",
    });
    expect(created.id).toBe("lectures/module-1/intro");
    expect(created.resource).toBe("llteacher://materials/m-1");
    const raw = readFileSync(path.join(root, "courses", COURSE_A, "knowledge", "lectures/module-1/intro.md"), "utf8");
    expect(raw).toContain('resource: "llteacher://materials/m-1"');
    expect(raw).toContain("status: generated");
    expect(raw).toContain("generated: {");
    expect(existsSync(path.join(root, "courses", COURSE_A, "knowledge", "lectures/module-1/index.md"))).toBe(true);
    const log = readFileSync(path.join(root, "courses", COURSE_A, "knowledge", "log.md"), "utf8");
    expect(log).toContain("lectures/module-1/intro.md");
  });

  it("lists concepts with kinds and mtimes, excluding nothing", async () => {
    await svc.create(COURSE_A, { id: "syllabus", type: "syllabus", title: "Syllabus", description: "Course syllabus", body: "Weeks." });
    const all = await svc.list(COURSE_A);
    const kinds = all.map((c) => `${c.kind}:${c.id}`).sort();
    expect(kinds).toEqual(["concept:syllabus", "index:index", "log:log"]);
    expect(Date.parse(all[0]!.updatedAt)).not.toBeNaN();
  });

  it("returns an empty list for a course with no bundle yet", async () => {
    expect(await svc.list(COURSE_B)).toEqual([]);
  });

  it("searches and shows within one course only", async () => {
    await svc.create(COURSE_A, { id: "elasticity", type: "lecture", title: "Elasticity", description: "Price elasticity of demand", body: "Elastic goods respond strongly to price." });
    await svc.create(COURSE_B, { id: "elasticity", type: "lecture", title: "Other course", description: "Unrelated", body: "Nothing about prices." });
    const hits = await svc.search(COURSE_A, "elasticity price", 5);
    expect(hits.map((h) => h.conceptId)).toEqual(["elasticity"]);
    expect(hits[0]!.score).toBeGreaterThan(0);
    const shown = await svc.show(COURSE_A, "elasticity");
    expect(shown?.title).toBe("Elasticity");
    expect(shown?.body).toContain("Elastic goods");
    expect((await svc.show(COURSE_B, "elasticity"))?.title).toBe("Other course");
    expect(await svc.show(COURSE_A, "missing")).toBeNull();
  });

  it("returns [] for an empty search result", async () => {
    await svc.ensureBundle(COURSE_A);
    expect(await svc.search(COURSE_A, "zzzz", 5)).toEqual([]);
  });

  it("updates the body and preserves resource and status keys", async () => {
    await svc.create(COURSE_A, { id: "a", type: "note", title: "A", description: "d", body: "old", resource: "llteacher://materials/m-9" });
    const updated = await svc.update(COURSE_A, "a", { body: "new body" });
    expect(updated?.body.trim()).toBe("new body");
    expect(updated?.resource).toBe("llteacher://materials/m-9");
    expect(updated?.frontmatter.status).toBe("generated");
    expect(await svc.update(COURSE_A, "missing", { body: "x" })).toBeNull();
  });

  it("relates two concepts and reports outbound and inbound links", async () => {
    await svc.create(COURSE_A, { id: "a", type: "note", title: "A", description: "d", body: "a" });
    await svc.create(COURSE_A, { id: "b", type: "note", title: "B", description: "d", body: "b" });
    await svc.relate(COURSE_A, "a", "b", "a depends on b");
    expect((await svc.show(COURSE_A, "a"))?.outbound).toEqual(["b"]);
    expect((await svc.show(COURSE_A, "b"))?.inbound).toEqual(["a"]);
  });

  it("removes a concept, regenerates the directory index, and logs it", async () => {
    await svc.create(COURSE_A, { id: "d/one", type: "note", title: "One", description: "first", body: "1" });
    await svc.create(COURSE_A, { id: "d/two", type: "note", title: "Two", description: "second", body: "2" });
    expect(await svc.remove(COURSE_A, "d/one")).toBe(true);
    expect(await svc.remove(COURSE_A, "d/one")).toBe(false);
    const index = readFileSync(path.join(root, "courses", COURSE_A, "knowledge", "d/index.md"), "utf8");
    expect(index).toContain("[Two](two.md)");
    expect(index).not.toContain("one.md");
    const log = readFileSync(path.join(root, "courses", COURSE_A, "knowledge", "log.md"), "utf8");
    expect(log).toContain("**Deletion**");
  });

  it("removing a root-level concept regenerates the root index in okf's own format", async () => {
    await svc.create(COURSE_A, { id: "syllabus", type: "syllabus", title: "Syllabus", description: "Course syllabus", body: "" });
    await svc.create(COURSE_A, { id: "readings", type: "note", title: "Readings", description: "Assigned readings", body: "" });
    expect(await svc.remove(COURSE_A, "syllabus")).toBe(true);
    const index = readFileSync(path.join(root, "courses", COURSE_A, "knowledge", "index.md"), "utf8");
    expect(index.startsWith('---\nokf_version: "0.2"')).toBe(true);
    expect(index).toContain("# Knowledge Base");
    expect(index).toContain("[Readings](readings.md)");
    expect(index).not.toContain("syllabus.md");
  });

  it("returns [] from search when the course has no bundle yet", async () => {
    expect(await svc.search(COURSE_B, "anything")).toEqual([]);
  });

  it("creates an empty directory that survives listing", async () => {
    await svc.createDirectory(COURSE_A, "readings");
    const all = await svc.list(COURSE_A);
    expect(all.some((c) => c.kind === "index" && c.id === "readings/index")).toBe(true);
  });

  it("validates and reports broken links", async () => {
    await svc.create(COURSE_A, { id: "a", type: "note", title: "A", description: "d", body: "See [gone](gone.md)." });
    const report = await svc.validate(COURSE_A);
    expect(report.conceptCount).toBe(1);
    expect(report.brokenLinks).toEqual([{ source: "a", target: "gone" }]);
  });

  it("validates a course with no bundle yet without creating one on disk", async () => {
    const report = await svc.validate(COURSE_B);
    expect(report).toEqual({ conceptCount: 0, brokenLinks: [], orphans: [], isConformant: true });
    expect(existsSync(path.join(root, "courses", COURSE_B))).toBe(false);
  });

  it("rejects bad ids and bad course ids before touching okf", async () => {
    await expect(svc.show(COURSE_A, "Bad Id")).rejects.toBeInstanceOf(ConceptIdError);
    await expect(svc.show(COURSE_A, "../x")).rejects.toBeInstanceOf(ConceptIdError);
    await expect(svc.show("not-a-uuid", "a")).rejects.toBeInstanceOf(ConceptIdError);
    await expect(svc.create(COURSE_A, { id: "index", type: "t", title: "t", description: "d", body: "" })).rejects.toBeInstanceOf(ConceptIdError);
  });

  it("refuses to create over an existing concept", async () => {
    await svc.create(COURSE_A, { id: "dup", type: "note", title: "A", description: "d", body: "" });
    await expect(svc.create(COURSE_A, { id: "dup", type: "note", title: "A", description: "d", body: "" })).rejects.toBeInstanceOf(ConceptExistsError);
  });

  // #41 fix review, Important 2: list() reads only each file's frontmatter
  // head and caches the per-course result for 15s, since it's called on
  // every chat turn just to render a listing. These two tests prove the
  // cache actually serves stale reads within the TTL (by mutating a concept
  // file directly on disk, bypassing every svc write method so nothing
  // invalidates the cache) and that every write method invalidates it (by
  // going through svc.create/update/relate/remove/createDirectory, each of
  // which must make the very next list() see the new state despite being
  // well within the same 15s window).
  it("caches list() results for a course, serving a stale read within the TTL", async () => {
    await svc.create(COURSE_A, { id: "a", type: "note", title: "Original", description: "d", body: "a" });
    const first = await svc.list(COURSE_A);
    expect(first.find((c) => c.id === "a")?.title).toBe("Original");

    // Mutate the file on disk directly -- NOT through svc.update -- so the
    // service's cache is never told anything changed.
    const file = path.join(root, "courses", COURSE_A, "knowledge", "a.md");
    const raw = readFileSync(file, "utf8");
    writeFileSync(file, raw.replace("Original", "Mutated Behind The Cache's Back"), "utf8");

    const second = await svc.list(COURSE_A);
    expect(second.find((c) => c.id === "a")?.title).toBe("Original");
  });

  it("invalidates the cache on every write, so the next list() reflects it immediately", async () => {
    await svc.create(COURSE_A, { id: "b", type: "note", title: "B", description: "d", body: "b" });
    const afterCreate = await svc.list(COURSE_A);
    expect(afterCreate.find((c) => c.id === "b")?.title).toBe("B");

    await svc.update(COURSE_A, "b", { title: "B Updated" });
    const afterUpdate = await svc.list(COURSE_A);
    expect(afterUpdate.find((c) => c.id === "b")?.title).toBe("B Updated");

    await svc.create(COURSE_A, { id: "c", type: "note", title: "C", description: "d", body: "c" });
    await svc.relate(COURSE_A, "b", "c", "b depends on c");
    const afterRelate = await svc.list(COURSE_A);
    expect(afterRelate.map((x) => x.id)).toContain("c");

    await svc.remove(COURSE_A, "c");
    const afterRemove = await svc.list(COURSE_A);
    expect(afterRemove.map((x) => x.id)).not.toContain("c");

    await svc.createDirectory(COURSE_A, "new-dir");
    const afterCreateDirectory = await svc.list(COURSE_A);
    expect(afterCreateDirectory.some((x) => x.kind === "index" && x.id === "new-dir/index")).toBe(true);
  });
});
