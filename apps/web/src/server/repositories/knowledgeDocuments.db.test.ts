import { describe, it, expect, beforeAll } from "vitest";
import { makeNodeDb } from "../../db/nodeClient";
import type { Db } from "../../db/client";
import { courses, organizations } from "../../db/schema";
import { unsafeCourseScope, type CourseScope } from "./scope";
import {
  createDocument,
  deleteDocument,
  getDocument,
  getDocumentLinks,
  listDocuments,
  updateDocumentBody,
} from "./knowledgeDocuments";

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)("knowledgeDocuments repository", () => {
  let db: Db;
  let courseA: CourseScope;
  let courseB: CourseScope;

  beforeAll(async () => {
    db = makeNodeDb(DATABASE_URL!);
    const [org] = await db
      .insert(organizations)
      .values({
        slug: `kdoc-${crypto.randomUUID()}`,
        name: "KDoc",
        workosOrganizationId: `w-${crypto.randomUUID()}`,
      })
      .returning({ id: organizations.id });
    const made = await db
      .insert(courses)
      .values([
        { organizationId: org.id, code: "A", term: "T", title: "A" },
        { organizationId: org.id, code: "B", term: "T", title: "B" },
      ])
      .returning({ id: courses.id });
    courseA = unsafeCourseScope(made[0].id);
    courseB = unsafeCourseScope(made[1].id);
  });

  it("creates a concept and reads it back by id", async () => {
    const created = await createDocument(db, courseA, {
      path: "stats/regression",
      kind: "concept",
      type: "lecture",
      title: "Regression",
      body: "Linear models.",
    });
    const read = await getDocument(db, courseA, created.id);
    expect(read?.path).toBe("stats/regression");
    expect(read?.type).toBe("lecture");
    expect(read?.indexStatus).toBe("pending");
  });

  it("rejects a duplicate path within one course", async () => {
    await createDocument(db, courseA, { path: "dup", kind: "concept", type: "note", body: "" });
    await expect(
      createDocument(db, courseA, { path: "dup", kind: "concept", type: "note", body: "" }),
    ).rejects.toThrow();
  });

  it("allows the same path in a different course", async () => {
    await createDocument(db, courseA, { path: "shared", kind: "concept", type: "note", body: "" });
    const inB = await createDocument(db, courseB, {
      path: "shared",
      kind: "concept",
      type: "note",
      body: "",
    });
    expect(inB.path).toBe("shared");
  });

  it("rejects a concept named index or log", async () => {
    await expect(
      createDocument(db, courseA, { path: "week1/index", kind: "concept", type: "note", body: "" }),
    ).rejects.toThrow();
  });

  it("does not return another course's document", async () => {
    const inB = await createDocument(db, courseB, {
      path: "isolated",
      kind: "concept",
      type: "note",
      body: "",
    });
    expect(await getDocument(db, courseA, inB.id)).toBeNull();
  });

  it("lists only the calling course's documents", async () => {
    const listed = await listDocuments(db, courseB);
    expect(listed.every((d) => d.path !== "stats/regression")).toBe(true);
  });

  it("stores resolved links and their backlinks", async () => {
    const target = await createDocument(db, courseA, {
      path: "linkable/target",
      kind: "concept",
      type: "note",
      body: "",
    });
    const source = await createDocument(db, courseA, {
      path: "linkable/source",
      kind: "concept",
      type: "note",
      body: "see [target](/linkable/target)",
    });

    const outbound = await getDocumentLinks(db, courseA, source.id);
    expect(outbound.outbound).toEqual([
      { rawHref: "/linkable/target", targetPath: "linkable/target", resolvedDocumentId: target.id, isBroken: false },
    ]);

    const inbound = await getDocumentLinks(db, courseA, target.id);
    expect(inbound.backlinks.map((b) => b.sourceDocumentId)).toEqual([source.id]);
  });

  it("stores a broken link rather than dropping it", async () => {
    const doc = await createDocument(db, courseA, {
      path: "broken/source",
      kind: "concept",
      type: "note",
      body: "see [gone](/nowhere/at/all)",
    });
    const { outbound } = await getDocumentLinks(db, courseA, doc.id);
    expect(outbound).toEqual([
      { rawHref: "/nowhere/at/all", targetPath: "nowhere/at/all", resolvedDocumentId: null, isBroken: true },
    ]);
  });

  it("editing the body rebuilds links and resets index_status", async () => {
    const doc = await createDocument(db, courseA, {
      path: "edited",
      kind: "concept",
      type: "note",
      body: "see [a](/gone-a)",
    });
    await updateDocumentBody(db, courseA, doc.id, { body: "see [b](/gone-b)", editedById: null });

    const { outbound } = await getDocumentLinks(db, courseA, doc.id);
    expect(outbound.map((l) => l.targetPath)).toEqual(["gone-b"]);
    expect((await getDocument(db, courseA, doc.id))?.indexStatus).toBe("pending");
  });

  it("refuses to delete another course's document", async () => {
    const inB = await createDocument(db, courseB, {
      path: "b-only",
      kind: "concept",
      type: "note",
      body: "",
    });
    expect(await deleteDocument(db, courseA, inB.id)).toBeNull();
    expect(await getDocument(db, courseB, inB.id)).not.toBeNull();
  });

  it("returns the removed path, which the route layer needs for log.md", async () => {
    const doc = await createDocument(db, courseA, {
      path: "removable",
      kind: "concept",
      type: "note",
      body: "",
    });
    expect(await deleteDocument(db, courseA, doc.id)).toEqual({ path: "removable" });
  });
});
