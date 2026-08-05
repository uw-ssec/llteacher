import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { makeNodeDb } from "../../db/nodeClient";
import type { Db } from "../../db/client";
import { organizations, courses, users, courseMemberships, courseMaterials } from "../../db/schema";
import { unsafeCourseScope } from "./scope";
import { listMaterialsForCourse } from "./materials";

const DATABASE_URL = process.env.DATABASE_URL;

// #149: listMaterialsForCourse had zero test coverage despite the Phase-4
// commit claiming cross-org isolation tests for every repository it added.
// No production route calls it yet -- it's awaiting M7's RAG/course-materials
// upload-and-ingestion pipeline, not dead code.
describe.skipIf(!DATABASE_URL)("materials repository", () => {
  let db: Db;
  let orgAId: string;
  let orgBId: string;
  let courseAId: string;
  let courseBId: string;
  let materialAId: string;
  let materialBId: string;

  beforeAll(async () => {
    db = makeNodeDb(DATABASE_URL!);
    async function seed(label: string) {
      const [org] = await db
        .insert(organizations)
        .values({ slug: `mat-${label}-${crypto.randomUUID()}`, name: label, workosOrganizationId: `w-${label}-${crypto.randomUUID()}` })
        .returning({ id: organizations.id });
      const [course] = await db
        .insert(courses)
        .values({ organizationId: org.id, code: "C", term: "T", title: "T" })
        .returning({ id: courses.id });
      const emailBytes = crypto.getRandomValues(new Uint8Array(32));
      const [user] = await db
        .insert(users)
        .values({ email: emailBytes as never, emailBlindIndex: emailBytes as never })
        .returning({ id: users.id });
      const [membership] = await db
        .insert(courseMemberships)
        .values({ userId: user.id, courseId: course.id, role: "instructor" })
        .returning({ id: courseMemberships.id });
      const [material] = await db
        .insert(courseMaterials)
        .values({ courseId: course.id, uploadedById: membership.id, sourceType: "pdf", title: `${label}-material` })
        .returning({ id: courseMaterials.id });
      return { orgId: org.id, courseId: course.id, materialId: material.id };
    }
    const a = await seed("a");
    orgAId = a.orgId;
    courseAId = a.courseId;
    materialAId = a.materialId;
    const b = await seed("b");
    orgBId = b.orgId;
    courseBId = b.courseId;
    materialBId = b.materialId;
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgAId));
    await db.delete(organizations).where(eq(organizations.id, orgBId));
  });

  // Mutation-check: asserts course B's list is exactly [materialBId], not
  // just non-empty -- if listMaterialsForCourse's courseId filter were ever
  // dropped, this would include materialAId too and fail.
  it("listMaterialsForCourse scoped to course B returns only course B's material, never course A's", async () => {
    const rows = await listMaterialsForCourse(db, unsafeCourseScope(courseBId));
    expect(rows.map((r) => r.id)).toEqual([materialBId]);
  });

  it("listMaterialsForCourse scoped to course A returns only course A's material", async () => {
    const rows = await listMaterialsForCourse(db, unsafeCourseScope(courseAId));
    expect(rows.map((r) => r.id)).toEqual([materialAId]);
  });

  it("returns an empty array for a course with no materials", async () => {
    const [emptyOrg] = await db
      .insert(organizations)
      .values({ slug: `mat-empty-${crypto.randomUUID()}`, name: "empty", workosOrganizationId: `w-empty-${crypto.randomUUID()}` })
      .returning({ id: organizations.id });
    const [emptyCourse] = await db
      .insert(courses)
      .values({ organizationId: emptyOrg.id, code: "E", term: "T", title: "T" })
      .returning({ id: courses.id });
    const rows = await listMaterialsForCourse(db, unsafeCourseScope(emptyCourse.id));
    expect(rows).toEqual([]);
    await db.delete(organizations).where(eq(organizations.id, emptyOrg.id));
  });
});
