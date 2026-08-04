import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { listMembershipsForUser } from "./users";
import type { Db } from "../../db/client";
import { makeNodeDb } from "../../db/nodeClient";
import { organizations, courses, users, courseMemberships } from "../../db/schema";

describe("users repository", () => {
  it("listMembershipsForUser queries course_memberships by the given userId", async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: "m1", userId: "u1", courseId: "course-a", role: "instructor" }]);
    const db = { query: { courseMemberships: { findMany } } } as unknown as Db;

    const result = await listMembershipsForUser(db, "u1");

    expect(result).toEqual([{ id: "m1", userId: "u1", courseId: "course-a", role: "instructor" }]);
    expect(findMany).toHaveBeenCalledOnce();
  });
});

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)("listMembershipsForUser droppedAt filtering (#139, real DB)", () => {
  let db: Db;
  let orgId: string;
  let activeCourseId: string;
  let droppedCourseId: string;
  let userId: string;

  beforeAll(async () => {
    db = makeNodeDb(DATABASE_URL!);
    const [org] = await db
      .insert(organizations)
      .values({ slug: `dropped-${crypto.randomUUID()}`, name: "Dropped Test Org", workosOrganizationId: `w-${crypto.randomUUID()}` })
      .returning({ id: organizations.id });
    orgId = org.id;

    const [active] = await db
      .insert(courses)
      .values({ organizationId: orgId, code: "ACTIVE", term: "T", title: "T" })
      .returning({ id: courses.id });
    activeCourseId = active.id;
    const [dropped] = await db
      .insert(courses)
      .values({ organizationId: orgId, code: "DROPPED", term: "T", title: "T" })
      .returning({ id: courses.id });
    droppedCourseId = dropped.id;

    const emailBytes = crypto.getRandomValues(new Uint8Array(32));
    const [user] = await db
      .insert(users)
      .values({ email: emailBytes as never, emailBlindIndex: emailBytes as never })
      .returning({ id: users.id });
    userId = user.id;

    await db.insert(courseMemberships).values({ userId, courseId: activeCourseId, role: "instructor" });
    await db.insert(courseMemberships).values({
      userId,
      courseId: droppedCourseId,
      role: "instructor",
      droppedAt: new Date(),
    });
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("excludes a dropped membership, includes an active one", async () => {
    const memberships = await listMembershipsForUser(db, userId);
    expect(memberships.map((m) => m.courseId)).toContain(activeCourseId);
    expect(memberships.map((m) => m.courseId)).not.toContain(droppedCourseId);
  });

  it("a dropped membership no longer satisfies isMemberOf/isInstructorOf (mirrors rolesMiddleware's derivation)", async () => {
    // roles.ts derives every AuthContext predicate from exactly this
    // array -- applying the same one-liners here proves the droppedAt
    // filter actually revokes isMemberOf/isInstructorOf, not just that the
    // row is missing from a raw query result. A full HTTP-level 403
    // assertion isn't practical here: rolesMiddleware calls makeDb(), whose
    // Neon HTTP driver can't reach a plain local Postgres (see plan doc
    // decision #9), so an end-to-end route test would need a live Neon
    // endpoint rather than the local DB this suite runs against.
    const memberships = await listMembershipsForUser(db, userId);
    const isMemberOf = (courseId: string) => memberships.some((m) => m.courseId === courseId);
    const isInstructorOf = (courseId: string) =>
      memberships.some((m) => m.courseId === courseId && (m.role === "instructor" || m.role === "admin"));

    expect(isMemberOf(droppedCourseId)).toBe(false);
    expect(isInstructorOf(droppedCourseId)).toBe(false);
    expect(isMemberOf(activeCourseId)).toBe(true);
    expect(isInstructorOf(activeCourseId)).toBe(true);
  });
});
