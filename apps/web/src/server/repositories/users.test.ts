import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { listMembershipsForUser, getUserActivationState, deactivateByWorkosUserId } from "./users";
import type { Db } from "../../db/client";
import { makeNodeDb } from "../../db/nodeClient";
import { organizations, courses, users, courseMemberships } from "../../db/schema";

const RAW_DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!RAW_DATABASE_URL)("course_memberships.dropped_reason CHECK (#142, real DB)", () => {
  it("rejects a dropped_reason set without dropped_at", async () => {
    const db = makeNodeDb(RAW_DATABASE_URL!);
    const [org] = await db
      .insert(organizations)
      .values({
        slug: `check-${crypto.randomUUID()}`,
        name: "Check Test Org",
        workosOrganizationId: `w-${crypto.randomUUID()}`,
      })
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

    await expect(
      db.insert(courseMemberships).values({
        userId: user.id,
        courseId: course.id,
        role: "student",
        droppedReason: "user_deprovisioned",
      }),
    ).rejects.toThrow();

    await db.delete(organizations).where(eq(organizations.id, org.id));
    await db.delete(users).where(eq(users.id, user.id));
  });
});

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

describe.skipIf(!DATABASE_URL)("deactivateByWorkosUserId / getUserActivationState (#95, real DB)", () => {
  let db: Db;
  let orgId: string;
  let courseId: string;
  let userId: string;
  const workosUserId = `workos-${crypto.randomUUID()}`;

  beforeAll(async () => {
    db = makeNodeDb(DATABASE_URL!);
    const [org] = await db
      .insert(organizations)
      .values({ slug: `deact-${crypto.randomUUID()}`, name: "Deactivation Test Org", workosOrganizationId: `w-${crypto.randomUUID()}` })
      .returning({ id: organizations.id });
    orgId = org.id;
    const [course] = await db
      .insert(courses)
      .values({ organizationId: orgId, code: "C", term: "T", title: "T" })
      .returning({ id: courses.id });
    courseId = course.id;

    const emailBytes = crypto.getRandomValues(new Uint8Array(32));
    const [user] = await db
      .insert(users)
      .values({ workosUserId, email: emailBytes as never, emailBlindIndex: emailBytes as never })
      .returning({ id: users.id });
    userId = user.id;
    await db.insert(courseMemberships).values({ userId, courseId, role: "student" });
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("getUserActivationState returns the fresh-user defaults", async () => {
    const state = await getUserActivationState(db, userId);
    expect(state).toEqual({ isActive: true, sessionEpoch: 0 });
  });

  it("deactivateByWorkosUserId flips isActive false, bumps sessionEpoch, returns org scopes, and cascades the drop into course_memberships (#142)", async () => {
    const result = await deactivateByWorkosUserId(db, workosUserId);
    expect(result?.userId).toBe(userId);
    expect(result?.orgScopes).toEqual([orgId]);

    const state = await getUserActivationState(db, userId);
    expect(state).toEqual({ isActive: false, sessionEpoch: 1 });

    const membership = await db.query.courseMemberships.findFirst({
      where: eq(courseMemberships.userId, userId),
    });
    expect(membership?.droppedAt).not.toBeNull();
    expect(membership?.droppedReason).toBe("user_deprovisioned");
  });

  it("is idempotent: a second call on an already-deactivated user is a no-op, not a double-bump", async () => {
    const result = await deactivateByWorkosUserId(db, workosUserId);
    expect(result).toBeNull();

    const state = await getUserActivationState(db, userId);
    expect(state?.sessionEpoch).toBe(1);
  });

  it("returns null for an unknown workosUserId", async () => {
    const result = await deactivateByWorkosUserId(db, `workos-unknown-${crypto.randomUUID()}`);
    expect(result).toBeNull();
  });
});

describe.skipIf(!DATABASE_URL)(
  "deactivateByWorkosUserId membership cascade leaves unrelated drops alone (#142, real DB)",
  () => {
    let db: Db;
    let orgId: string;
    let courseAId: string;
    let courseBId: string;
    let userId: string;
    const workosUserId = `workos-${crypto.randomUUID()}`;

    beforeAll(async () => {
      db = makeNodeDb(DATABASE_URL!);
      const [org] = await db
        .insert(organizations)
        .values({
          slug: `cascade-${crypto.randomUUID()}`,
          name: "Cascade Test Org",
          workosOrganizationId: `w-${crypto.randomUUID()}`,
        })
        .returning({ id: organizations.id });
      orgId = org.id;
      const [courseA] = await db
        .insert(courses)
        .values({ organizationId: orgId, code: "A", term: "T", title: "T" })
        .returning({ id: courses.id });
      courseAId = courseA.id;
      const [courseB] = await db
        .insert(courses)
        .values({ organizationId: orgId, code: "B", term: "T", title: "T" })
        .returning({ id: courses.id });
      courseBId = courseB.id;

      const emailBytes = crypto.getRandomValues(new Uint8Array(32));
      const [user] = await db
        .insert(users)
        .values({ workosUserId, email: emailBytes as never, emailBlindIndex: emailBytes as never })
        .returning({ id: users.id });
      userId = user.id;

      // Still active -- deactivation should cascade-drop this one.
      await db.insert(courseMemberships).values({ userId, courseId: courseAId, role: "student" });
      // Already dropped for an unrelated reason (e.g. a prior Canvas roster
      // removal) -- deactivation must leave this one's reason untouched.
      await db.insert(courseMemberships).values({
        userId,
        courseId: courseBId,
        role: "student",
        droppedAt: new Date("2020-01-01T00:00:00Z"),
        droppedReason: "roster_removal",
      });
    });

    afterAll(async () => {
      await db.delete(organizations).where(eq(organizations.id, orgId));
      await db.delete(users).where(eq(users.id, userId));
    });

    it("tags the active membership as user_deprovisioned but leaves the already-dropped one's reason alone", async () => {
      await deactivateByWorkosUserId(db, workosUserId);

      const membershipA = await db.query.courseMemberships.findFirst({
        where: eq(courseMemberships.courseId, courseAId),
      });
      expect(membershipA?.droppedReason).toBe("user_deprovisioned");

      const membershipB = await db.query.courseMemberships.findFirst({
        where: eq(courseMemberships.courseId, courseBId),
      });
      expect(membershipB?.droppedReason).toBe("roster_removal");
      expect(membershipB?.droppedAt?.toISOString()).toBe("2020-01-01T00:00:00.000Z");
    });
  },
);
