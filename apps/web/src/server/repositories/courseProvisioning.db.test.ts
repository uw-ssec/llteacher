import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { makeNodeDb } from "../../db/nodeClient";
import type { Db } from "../../db/client";
import { courseMemberships, courses, organizations, users } from "../../db/schema";
import { IdentityCipher } from "../../lib/crypto/identity-cipher";
import { loadIdentityCipherKeys } from "../../lib/secrets-loader";
import { provisionInstructorCourse } from "./courseProvisioning";

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

  afterAll(async () => {
    await db.execute(sql`DROP TRIGGER IF EXISTS test_fail_instructor_membership ON course_memberships`);
    await db.execute(sql`DROP FUNCTION IF EXISTS test_fail_instructor_membership()`);
    await db.delete(courses).where(eq(courses.organizationId, deploymentOrgId));
    await db.delete(organizations).where(eq(organizations.id, deploymentOrgId));
    await db.delete(organizations).where(eq(organizations.id, ordinaryOrgId));
    await db.delete(users).where(eq(users.platformInstructorGrantedBy, actorUserId));
    await db.delete(users).where(eq(users.id, actorUserId));
  });

  it("uses the marked deployment institution, not an unrelated organization row", async () => {
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
});
