import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { makeNodeDb } from "../../db/nodeClient";
import type { Db } from "../../db/client";
import { organizations, courses } from "../../db/schema";
import { getCourseTitle } from "./courses";

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
});
