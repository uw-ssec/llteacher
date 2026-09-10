import { describe, it, expect, beforeAll } from "vitest";
import { makeNodeDb } from "../../db/nodeClient";
import type { Db } from "../../db/client";
import { courseMemberships, courses, homeworks, organizations, sections, users } from "../../db/schema";
import { unsafeCourseScope, type CourseScope } from "./scope";
import { createDocument } from "./knowledgeDocuments";
import {
  attachCollection,
  createCollection,
  deleteCollection,
  getCollectionItems,
  homeworkBelongsToCourse,
  listCollections,
  listDocumentsInCollections,
  resolveForTarget,
  sectionBelongsToCourse,
  setCollectionItems,
} from "./knowledgeCollections";

const DATABASE_URL = process.env.DATABASE_URL;

/** `users.email` and `.email_blind_index` are NOT NULL encrypted columns
 *  (AES-256-GCM ciphertext and an HMAC blind index). This suite never reads
 *  them back, so random bytes of the right shape satisfy the branded types
 *  without dragging IdentityCipher into a collections test. Same helper, same
 *  reasoning, as courseMemberships.db.test.ts and submissions.db.test.ts. */
function randomBytes(): never {
  return crypto.getRandomValues(new Uint8Array(16)) as never;
}

describe.skipIf(!DATABASE_URL)("knowledgeCollections repository", () => {
  let db: Db;
  let courseA: CourseScope;
  let courseB: CourseScope;
  let membershipA: string;
  let homeworkA: string;
  let homeworkB: string;
  let sectionA: string;

  beforeAll(async () => {
    db = makeNodeDb(DATABASE_URL!);
    const [org] = await db
      .insert(organizations)
      .values({
        slug: `kcol-${crypto.randomUUID()}`,
        name: "KCol",
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

    const [user] = await db
      .insert(users)
      .values({ email: randomBytes(), emailBlindIndex: randomBytes() })
      .returning({ id: users.id });
    const [m] = await db
      .insert(courseMemberships)
      .values({ userId: user.id, courseId: courseA, role: "instructor" })
      .returning({ id: courseMemberships.id });
    membershipA = m.id;

    const [hwA, hwB] = await db
      .insert(homeworks)
      .values([
        {
          courseId: courseA,
          createdById: membershipA,
          title: "HW A",
          description: "",
          dueDate: new Date(),
        },
        {
          courseId: courseB,
          createdById: membershipA,
          title: "HW B",
          description: "",
          dueDate: new Date(),
        },
      ])
      .returning({ id: homeworks.id });
    homeworkA = hwA.id;
    homeworkB = hwB.id;

    const [secA] = await db
      .insert(sections)
      .values({ homeworkId: homeworkA, order: 1, title: "Sec A", content: "" })
      .returning({ id: sections.id });
    sectionA = secA.id;
  });

  it("creates and lists a collection", async () => {
    const created = await createCollection(db, courseA, {
      name: "Week 1",
      description: "Intro readings",
      createdById: membershipA,
    });
    const listed = await listCollections(db, courseA);
    expect(listed.map((c) => c.id)).toContain(created.id);
    expect(listed.find((c) => c.id === created.id)?.name).toBe("Week 1");
  });

  it("does not list another course's collections", async () => {
    await createCollection(db, courseA, { name: "A only", createdById: membershipA });
    expect((await listCollections(db, courseB)).map((c) => c.name)).not.toContain("A only");
  });

  it("resolves a directory item to its subtree, live", async () => {
    const collection = await createCollection(db, courseA, {
      name: "Subtree",
      createdById: membershipA,
    });
    await createDocument(db, courseA, { path: "wk/a", kind: "concept", type: "n", body: "" });
    await setCollectionItems(db, courseA, collection.id, [{ directoryPath: "wk" }]);

    const before = await listDocumentsInCollections(db, courseA, [collection.id]);
    expect(before.map((d) => d.path)).toEqual(["wk/a"]);

    // Added after the collection was defined; a live subtree picks it up.
    await createDocument(db, courseA, { path: "wk/b", kind: "concept", type: "n", body: "" });
    const after = await listDocumentsInCollections(db, courseA, [collection.id]);
    expect(after.map((d) => d.path).sort()).toEqual(["wk/a", "wk/b"]);
  });

  it("does not let a directory item match a sibling with a shared prefix", async () => {
    const collection = await createCollection(db, courseA, {
      name: "Prefix",
      createdById: membershipA,
    });
    await createDocument(db, courseA, { path: "week/a", kind: "concept", type: "n", body: "" });
    await createDocument(db, courseA, { path: "weekend/b", kind: "concept", type: "n", body: "" });
    await setCollectionItems(db, courseA, collection.id, [{ directoryPath: "week" }]);

    const docs = await listDocumentsInCollections(db, courseA, [collection.id]);
    expect(docs.map((d) => d.path)).toEqual(["week/a"]);
  });

  // I-6 (final review): `_` is inside PATH_RE's accepted alphabet, but it is
  // also LIKE's "match any one character" wildcard. Pre-fix, the directory
  // went into the pattern unescaped, so "week_1/%" would ALSO match
  // "weekX1/..." -- a folder named "week_1" leaked a sibling folder's
  // documents into the collection. This pins that a literal underscore in a
  // selected directory's name is matched literally, not as a wildcard.
  it("does not let a directory item with a literal underscore match an unrelated sibling", async () => {
    const collection = await createCollection(db, courseA, {
      name: "Underscore",
      createdById: membershipA,
    });
    await createDocument(db, courseA, { path: "week_1/a", kind: "concept", type: "n", body: "" });
    // Differs from "week_1" only in the character underscore would wildcard
    // over -- exactly the sibling an unescaped pattern would also match.
    await createDocument(db, courseA, { path: "weekX1/b", kind: "concept", type: "n", body: "" });
    await setCollectionItems(db, courseA, collection.id, [{ directoryPath: "week_1" }]);

    const docs = await listDocumentsInCollections(db, courseA, [collection.id]);
    expect(docs.map((d) => d.path)).toEqual(["week_1/a"]);
  });

  it("deduplicates a document selected both directly and via its folder", async () => {
    const collection = await createCollection(db, courseA, {
      name: "Overlap",
      createdById: membershipA,
    });
    const doc = await createDocument(db, courseA, {
      path: "ov/a",
      kind: "concept",
      type: "n",
      body: "",
    });
    await setCollectionItems(db, courseA, collection.id, [
      { directoryPath: "ov" },
      { documentId: doc.id },
    ]);
    expect(await listDocumentsInCollections(db, courseA, [collection.id])).toHaveLength(1);
  });

  it("round-trips a mixed selection of one document and one directory", async () => {
    const collection = await createCollection(db, courseA, {
      name: "Roundtrip",
      createdById: membershipA,
    });
    const doc = await createDocument(db, courseA, {
      path: "rt/a",
      kind: "concept",
      type: "n",
      body: "",
    });
    await setCollectionItems(db, courseA, collection.id, [
      { documentId: doc.id },
      { directoryPath: "rt/sub" },
    ]);

    const items = await getCollectionItems(db, courseA, collection.id);
    expect(items).toEqual(
      expect.arrayContaining([{ documentId: doc.id }, { directoryPath: "rt/sub" }]),
    );
    expect(items).toHaveLength(2);
  });

  it("returns nothing for a foreign collection id", async () => {
    const collection = await createCollection(db, courseA, {
      name: "Foreign",
      createdById: membershipA,
    });
    await setCollectionItems(db, courseA, collection.id, [{ directoryPath: "x" }]);

    expect(await getCollectionItems(db, courseB, collection.id)).toBeNull();
  });

  it("resolves attachments most-specific-wins", async () => {
    const courseLevel = await createCollection(db, courseA, {
      name: "Course default",
      createdById: membershipA,
    });
    await attachCollection(db, courseA, courseLevel.id, { kind: "course", courseId: courseA });

    const resolved = await resolveForTarget(db, courseA, { courseId: courseA });
    expect(resolved.level).toBe("course");
    expect(resolved.collectionIds).toContain(courseLevel.id);
  });

  it("returns level 'none' when nothing is attached", async () => {
    const resolved = await resolveForTarget(db, courseB, { courseId: courseB });
    expect(resolved).toEqual({ level: "none", collectionIds: [] });
  });

  it("refuses to delete another course's collection", async () => {
    const inA = await createCollection(db, courseA, {
      name: "Guarded",
      createdById: membershipA,
    });
    expect(await deleteCollection(db, courseB, inA.id)).toBe(false);
  });

  it("confirms a homework that belongs to the acting course", async () => {
    expect(await homeworkBelongsToCourse(db, courseA, homeworkA)).toBe(true);
  });

  it("refuses a homework that belongs to a different course", async () => {
    expect(await homeworkBelongsToCourse(db, courseA, homeworkB)).toBe(false);
  });

  it("confirms a section whose homework belongs to the acting course", async () => {
    expect(await sectionBelongsToCourse(db, courseA, sectionA)).toBe(true);
  });

  it("refuses a section whose homework belongs to a different course", async () => {
    expect(await sectionBelongsToCourse(db, courseB, sectionA)).toBe(false);
  });
});
