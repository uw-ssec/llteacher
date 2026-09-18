import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { makeNodeDb } from "../../db/nodeClient";
import type { Db } from "../../db/client";
import { organizations, courses } from "../../db/schema";
import { getCourseTitle, getKnowledgeInstruction, getKnowledgeInstructionParts, setKnowledgeInstruction, setKnowledgeInstructionDefault } from "./courses";
import { unsafeCourseScope, unsafeOrgScope } from "./scope";

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)("courses repository", () => {
  let db: Db;
  let orgId: string;
  let courseId: string;

  beforeAll(async () => {
    db = makeNodeDb(DATABASE_URL!);
    const [org] = await db
      .insert(organizations)
      .values({ slug: `courses-${crypto.randomUUID()}`, name: "t", workosOrganizationId: `w-${crypto.randomUUID()}` })
      .returning({ id: organizations.id });
    orgId = org.id;
    const [course] = await db
      .insert(courses)
      .values({ organizationId: orgId, code: "STATS 311", term: "Autumn 2026", title: "STATS 311 · Autumn 2026" })
      .returning({ id: courses.id });
    courseId = course.id;
  });

  afterAll(async () => {
    await db.delete(courses).where(eq(courses.id, courseId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  it("returns the course title, and null for an unknown course", async () => {
    expect(await getCourseTitle(db, courseId)).toBe("STATS 311 · Autumn 2026");
    expect(await getCourseTitle(db, crypto.randomUUID())).toBeNull();
  });

  it("stores and clears the course's tutor instruction", async () => {
    const scope = unsafeCourseScope(courseId);
    expect(await getKnowledgeInstruction(db, courseId)).toBeNull();
    await setKnowledgeInstruction(db, scope, "Search the notes first.");
    expect(await getKnowledgeInstruction(db, courseId)).toBe("Search the notes first.");
    await setKnowledgeInstruction(db, scope, null);
    expect(await getKnowledgeInstruction(db, courseId)).toBeNull();
  });

  it("falls back to the organisation's default, and reports both parts", async () => {
    const scope = unsafeCourseScope(courseId);
    await setKnowledgeInstruction(db, scope, null);
    await setKnowledgeInstructionDefault(db, unsafeOrgScope(orgId), "Org text.");
    expect(await getKnowledgeInstruction(db, courseId)).toBe("Org text.");
    await setKnowledgeInstruction(db, scope, "Course text.");
    expect(await getKnowledgeInstruction(db, courseId)).toBe("Course text.");
    expect(await getKnowledgeInstructionParts(db, courseId)).toEqual({ instruction: "Course text.", orgDefault: "Org text." });
    await setKnowledgeInstructionDefault(db, unsafeOrgScope(orgId), null);
    await setKnowledgeInstruction(db, scope, null);
    expect(await getKnowledgeInstruction(db, courseId)).toBeNull();
  });
});
