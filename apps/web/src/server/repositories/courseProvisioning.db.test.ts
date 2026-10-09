import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull, sql } from "drizzle-orm";
import { makeNodeDb } from "../../db/nodeClient";
import type { Db } from "../../db/client";
import { courseMemberships, courses, organizations, users } from "../../db/schema";
import { IdentityCipher } from "../../lib/crypto/identity-cipher";
import { loadIdentityCipherKeys } from "../../lib/secrets-loader";
import { addInstructorToCourse, provisionInstructorCourse, removeInstructorsFromCourse } from "./courseProvisioning";
import { grantPlatformInstructor } from "./users";
import { unsafeOrgScope } from "./scope";

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)("provisionInstructorCourse atomicity (real DB)", () => {
  let db: Db;
  let cipher: IdentityCipher;
  let actorUserId: string;
  let ordinaryOrgId: string;
  let deploymentOrgId: string;
  const suffix = crypto.randomUUID();

  beforeAll(async () => {
    db = makeNodeDb(DATABASE_URL!);
    cipher = new IdentityCipher(await loadIdentityCipherKeys({
      ENCRYPTION_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
      BLIND_INDEX_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
    } as Env));
    const [actor] = await db.insert(users).values({
      email: await cipher.encryptString(`actor-${suffix}@uw.edu`),
      emailBlindIndex: await cipher.computeBlindIndex(`actor-${suffix}@uw.edu`),
    }).returning({ id: users.id });
    actorUserId = actor!.id;
    const [ordinary] = await db.insert(organizations).values({
      name: "Ordinary fixture organization",
      slug: `ordinary-${suffix}`,
      allowedDomains: ["example.edu"],
    }).returning({ id: organizations.id });
    ordinaryOrgId = ordinary!.id;
    const [deployment] = await db.insert(organizations).values({
      name: "University of Washington",
      slug: `deployment-${suffix}`,
      allowedDomains: ["uw.edu"],
      deploymentSingleton: true,
    }).returning({ id: organizations.id });
    deploymentOrgId = deployment!.id;
  });

  afterEach(async () => {
    await db.execute(sql`DROP TRIGGER IF EXISTS test_fail_instructor_membership ON course_memberships`);
    await db.execute(sql`DROP FUNCTION IF EXISTS test_fail_instructor_membership()`);
  });

  afterAll(async () => {
    await db.delete(courses).where(eq(courses.organizationId, deploymentOrgId));
    await db.delete(organizations).where(eq(organizations.id, deploymentOrgId));
    await db.delete(organizations).where(eq(organizations.id, ordinaryOrgId));
    await db.delete(users).where(eq(users.platformInstructorGrantedBy, actorUserId));
    await db.delete(users).where(eq(users.id, actorUserId));
  });

  it("uses the marked deployment institution and preserves an existing platform grant", async () => {
    const result = await provisionInstructorCourse(db, cipher, actorUserId, {
      instructorEmail: `prof-success-${suffix}@uw.edu`,
      title: "Statistics",
      code: `STAT-${suffix}`,
      term: "Autumn 2026",
    });
    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    const [created] = await db.select({ organizationId: courses.organizationId })
      .from(courses).where(eq(courses.id, result.course.id));
    expect(created!.organizationId).toBe(deploymentOrgId);
    expect(result.platformInstructorGrantCreated).toBe(true);
    const [firstGrant] = await db.select({
      grantedAt: users.platformInstructorGrantedAt,
      grantedBy: users.platformInstructorGrantedBy,
    }).from(users).where(eq(users.id, result.instructor.userId));

    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await provisionInstructorCourse(db, cipher, actorUserId, {
      instructorEmail: `prof-success-${suffix}@uw.edu`,
      title: "Statistics II",
      code: `STAT2-${suffix}`,
      term: "Winter 2027",
    });
    expect(second.status).toBe("created");
    if (second.status !== "created") return;
    expect(second.platformInstructorGrantCreated).toBe(false);
    const [secondGrant] = await db.select({
      grantedAt: users.platformInstructorGrantedAt,
      grantedBy: users.platformInstructorGrantedBy,
    }).from(users).where(eq(users.id, result.instructor.userId));
    expect(secondGrant).toEqual(firstGrant);
  });

  it("reports exactly one grant creator when course provisioning races a direct grant", async () => {
    const email = `prof-cross-flow-race-${suffix}@uw.edu`;
    await db.insert(users).values({
      email: await cipher.encryptString(email),
      emailBlindIndex: await cipher.computeBlindIndex(email),
    });

    const [courseResult, directResult] = await Promise.all([
      provisionInstructorCourse(db, cipher, actorUserId, {
        instructorEmail: email,
        title: "Cross-flow Race",
        code: `RACE-${suffix}`,
        term: "Autumn 2026",
      }),
      grantPlatformInstructor(db, cipher, actorUserId, email),
    ]);

    expect(courseResult.status).toBe("created");
    expect(directResult.status).toBe("granted");
    if (courseResult.status !== "created" || directResult.status !== "granted") return;
    expect([
      courseResult.platformInstructorGrantCreated,
      directResult.grantCreated,
    ].filter(Boolean)).toHaveLength(1);
  });

  it("rolls back user, grant, course, and membership when the final membership write fails", async () => {
    const code = `ROLLBACK-${suffix}`;
    const email = `prof-rollback-${suffix}@uw.edu`;
    const emailBlindIndex = await cipher.computeBlindIndex(email);
    await db.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION test_fail_instructor_membership() RETURNS trigger AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM courses WHERE id = NEW.course_id AND code LIKE 'ROLLBACK-%') THEN
          RAISE EXCEPTION 'intentional membership failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `));
    await db.execute(sql`
      CREATE TRIGGER test_fail_instructor_membership
      BEFORE INSERT ON course_memberships
      FOR EACH ROW EXECUTE FUNCTION test_fail_instructor_membership()
    `);

    await expect(provisionInstructorCourse(db, cipher, actorUserId, {
      instructorEmail: email,
      title: "Rollback Course",
      code,
      term: "Autumn 2026",
    })).rejects.toThrow("intentional membership failure");

    const createdUsers = await db.select({ id: users.id }).from(users).where(eq(users.emailBlindIndex, emailBlindIndex));
    const createdCourses = await db.select({ id: courses.id }).from(courses).where(and(
      eq(courses.organizationId, deploymentOrgId),
      eq(courses.code, code),
    ));
    const createdMemberships = createdCourses.length === 0
      ? []
      : await db.select({ id: courseMemberships.id }).from(courseMemberships)
          .where(eq(courseMemberships.courseId, createdCourses[0]!.id));
    expect(createdUsers).toEqual([]);
    expect(createdCourses).toEqual([]);
    expect(createdMemberships).toEqual([]);
  });

  it("adds a second instructor without changing the existing instructor", async () => {
    const first = await provisionInstructorCourse(db, cipher, actorUserId, {
      instructorEmail: `prof-primary-${suffix}@uw.edu`,
      title: "Co-taught Statistics",
      code: `COTEACH-${suffix}`,
      term: "Autumn 2026",
    });
    expect(first.status).toBe("created");
    if (first.status !== "created") return;

    const second = await addInstructorToCourse(
      db,
      cipher,
      actorUserId,
      first.course.id,
      `prof-second-${suffix}@uw.edu`,
    );

    expect(second).toMatchObject({
      status: "assigned",
      membershipAdded: true,
      platformInstructorGrantCreated: true,
      instructor: { email: `prof-second-${suffix}@uw.edu` },
    });
    const activeInstructors = await db.select({ userId: courseMemberships.userId })
      .from(courseMemberships)
      .where(and(
        eq(courseMemberships.courseId, first.course.id),
        eq(courseMemberships.role, "instructor"),
        isNull(courseMemberships.droppedAt),
      ));
    expect(activeInstructors.map(({ userId }) => userId).sort()).toEqual([
      first.instructor.userId,
      second.status === "assigned" ? second.instructor.userId : "",
    ].sort());
  });

  it("removes selected instructors only from one course, retaining their platform grant and other course", async () => {
    const email = `prof-removal-${suffix}@uw.edu`;
    const first = await provisionInstructorCourse(db, cipher, actorUserId, {
      instructorEmail: email, title: "First removal fixture", code: `REMOVE-1-${suffix}`, term: "Autumn 2026",
    });
    const second = await provisionInstructorCourse(db, cipher, actorUserId, {
      instructorEmail: email, title: "Second removal fixture", code: `REMOVE-2-${suffix}`, term: "Winter 2027",
    });
    expect(first.status).toBe("created");
    expect(second.status).toBe("created");
    if (first.status !== "created" || second.status !== "created") return;

    const result = await removeInstructorsFromCourse(db, unsafeOrgScope(deploymentOrgId), first.course.id, [first.instructor.userId]);
    expect(result).toMatchObject({ status: "removed", removed: [{ userId: first.instructor.userId, membershipId: first.membershipId }] });
    const memberships = await db.select({ courseId: courseMemberships.courseId, droppedAt: courseMemberships.droppedAt })
      .from(courseMemberships).where(eq(courseMemberships.userId, first.instructor.userId));
    expect(memberships.find((row) => row.courseId === first.course.id)?.droppedAt).not.toBeNull();
    expect(memberships.find((row) => row.courseId === second.course.id)?.droppedAt).toBeNull();
    const [person] = await db.select({ grantedAt: users.platformInstructorGrantedAt })
      .from(users).where(eq(users.id, first.instructor.userId));
    expect(person?.grantedAt).not.toBeNull();
  });

  it("rejects a stale batch without removing any current instructors", async () => {
    const first = await provisionInstructorCourse(db, cipher, actorUserId, {
      instructorEmail: `prof-stale-${suffix}@uw.edu`, title: "Stale removal fixture",
      code: `REMOVE-STALE-${suffix}`, term: "Autumn 2026",
    });
    expect(first.status).toBe("created");
    if (first.status !== "created") return;

    expect(await removeInstructorsFromCourse(db, unsafeOrgScope(deploymentOrgId), first.course.id, [first.instructor.userId, crypto.randomUUID()]))
      .toEqual({ status: "invalid_selection" });
    const [membership] = await db.select({ droppedAt: courseMemberships.droppedAt })
      .from(courseMemberships).where(eq(courseMemberships.id, first.membershipId));
    expect(membership?.droppedAt).toBeNull();
    expect(await removeInstructorsFromCourse(db, unsafeOrgScope(deploymentOrgId), crypto.randomUUID(), [first.instructor.userId]))
      .toEqual({ status: "course_missing" });
  });

  it("is idempotent for an active instructor and restores a dropped membership", async () => {
    const provisioned = await provisionInstructorCourse(db, cipher, actorUserId, {
      instructorEmail: `prof-owner-${suffix}@uw.edu`,
      title: "Membership Recovery",
      code: `RESTORE-${suffix}`,
      term: "Winter 2027",
    });
    expect(provisioned.status).toBe("created");
    if (provisioned.status !== "created") return;
    const email = `prof-restored-${suffix}@uw.edu`;

    const added = await addInstructorToCourse(db, cipher, actorUserId, provisioned.course.id, email);
    expect(added).toMatchObject({ status: "assigned", membershipAdded: true });
    if (added.status !== "assigned") return;
    const repeated = await addInstructorToCourse(db, cipher, actorUserId, provisioned.course.id, email);
    expect(repeated).toMatchObject({
      status: "assigned",
      membershipAdded: false,
      platformInstructorGrantCreated: false,
      membershipId: added.membershipId,
    });

    await db.update(courseMemberships).set({
      droppedAt: new Date("2026-10-01T00:00:00Z"),
      droppedReason: "roster_removal",
    }).where(eq(courseMemberships.id, added.membershipId));
    const restored = await addInstructorToCourse(db, cipher, actorUserId, provisioned.course.id, email);
    expect(restored).toMatchObject({
      status: "assigned",
      membershipAdded: true,
      platformInstructorGrantCreated: false,
      membershipId: added.membershipId,
    });
    const [membership] = await db.select({
      role: courseMemberships.role,
      droppedAt: courseMemberships.droppedAt,
      droppedReason: courseMemberships.droppedReason,
    }).from(courseMemberships).where(eq(courseMemberships.id, added.membershipId));
    expect(membership).toEqual({ role: "instructor", droppedAt: null, droppedReason: null });
  });

  it("rejects an unknown or other-organization course without creating the instructor", async () => {
    const [ordinaryCourse] = await db.insert(courses).values({
      organizationId: ordinaryOrgId,
      title: "Other institution course",
      code: `OTHER-${suffix}`,
      term: "Autumn 2026",
    }).returning({ id: courses.id });
    const email = `prof-wrong-org-${suffix}@uw.edu`;
    const blindIndex = await cipher.computeBlindIndex(email);

    await expect(addInstructorToCourse(db, cipher, actorUserId, crypto.randomUUID(), email))
      .resolves.toEqual({ status: "course_missing" });
    await expect(addInstructorToCourse(db, cipher, actorUserId, ordinaryCourse!.id, email))
      .resolves.toEqual({ status: "course_missing" });
    expect(await db.select({ id: users.id }).from(users).where(eq(users.emailBlindIndex, blindIndex))).toEqual([]);
    await db.delete(courses).where(eq(courses.id, ordinaryCourse!.id));
  });

  it("rejects a disallowed email without creating a user or membership", async () => {
    const provisioned = await provisionInstructorCourse(db, cipher, actorUserId, {
      instructorEmail: `prof-domain-owner-${suffix}@uw.edu`,
      title: "Domain Policy",
      code: `DOMAIN-${suffix}`,
      term: "Spring 2027",
    });
    expect(provisioned.status).toBe("created");
    if (provisioned.status !== "created") return;
    const email = `outsider-${suffix}@example.com`;
    const blindIndex = await cipher.computeBlindIndex(email);

    const result = await addInstructorToCourse(db, cipher, actorUserId, provisioned.course.id, email);

    expect(result).toMatchObject({ status: "invalid_email" });
    expect(await db.select({ id: users.id }).from(users).where(eq(users.emailBlindIndex, blindIndex))).toEqual([]);
  });

  it("rejects a malformed institutional email without creating any authority", async () => {
    const provisioned = await provisionInstructorCourse(db, cipher, actorUserId, {
      instructorEmail: `prof-malformed-owner-${suffix}@uw.edu`,
      title: "Malformed Instructor Domain",
      code: `MALFORMED-${suffix}`,
      term: "Spring 2027",
    });
    expect(provisioned.status).toBe("created");
    if (provisioned.status !== "created") return;
    const email = `prof-malformed-${suffix}@.uw.edu`;
    const blindIndex = await cipher.computeBlindIndex(email);

    expect(await addInstructorToCourse(db, cipher, actorUserId, provisioned.course.id, email))
      .toMatchObject({ status: "invalid_email" });
    expect(await db.select({ id: users.id }).from(users).where(eq(users.emailBlindIndex, blindIndex))).toEqual([]);
    const memberships = await db.select({ userId: courseMemberships.userId })
      .from(courseMemberships).where(eq(courseMemberships.courseId, provisioned.course.id));
    expect(memberships).toEqual([{ userId: provisioned.instructor.userId }]);
  });

  it("rolls back a new user and platform grant when membership insertion fails", async () => {
    const provisioned = await provisionInstructorCourse(db, cipher, actorUserId, {
      instructorEmail: `prof-rollback-owner-${suffix}@uw.edu`,
      title: "Add Instructor Rollback",
      code: `ADD-ROLLBACK-${suffix}`,
      term: "Spring 2027",
    });
    expect(provisioned.status).toBe("created");
    if (provisioned.status !== "created") return;
    const email = `prof-add-rollback-${suffix}@uw.edu`;
    const blindIndex = await cipher.computeBlindIndex(email);
    await db.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION test_fail_instructor_membership() RETURNS trigger AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM courses WHERE id = NEW.course_id AND code LIKE 'ADD-ROLLBACK-%') THEN
          RAISE EXCEPTION 'intentional add-instructor membership failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `));
    await db.execute(sql`
      CREATE TRIGGER test_fail_instructor_membership
      BEFORE INSERT ON course_memberships
      FOR EACH ROW EXECUTE FUNCTION test_fail_instructor_membership()
    `);

    await expect(addInstructorToCourse(db, cipher, actorUserId, provisioned.course.id, email))
      .rejects.toThrow("intentional add-instructor membership failure");
    expect(await db.select({ id: users.id }).from(users).where(eq(users.emailBlindIndex, blindIndex))).toEqual([]);
  });
});
