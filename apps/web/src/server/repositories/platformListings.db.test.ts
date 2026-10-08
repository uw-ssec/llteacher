import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { makeNodeDb } from "../../db/nodeClient";
import { courseMemberships, courses, organizations, users } from "../../db/schema";
import { IdentityCipher } from "../../lib/crypto/identity-cipher";
import { loadIdentityCipherKeys } from "../../lib/secrets-loader";
import { listPlatformCourses, listPlatformInstructors } from "./platformListings";

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)("platform super-admin listings (real DB)", () => {
  let db: Db;
  let cipher: IdentityCipher;
  let deploymentOrgId: string;
  let ordinaryOrgId: string;
  let visibleCourseId: string;
  let hiddenCourseId: string;
  let signedInUserId: string;
  let pendingUserId: string;
  let secondInstructorId: string;
  const suffix = crypto.randomUUID();

  beforeAll(async () => {
    db = makeNodeDb(DATABASE_URL!);
    cipher = new IdentityCipher(await loadIdentityCipherKeys({
      ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
      BLIND_INDEX_KEY: process.env.BLIND_INDEX_KEY ?? Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
    } as Env));
    const deployment = await db.query.organizations.findFirst({
      where: eq(organizations.deploymentSingleton, true), columns: { id: true },
    });
    if (!deployment) throw new Error("platform listing DB test requires the deployment organization fixture");
    deploymentOrgId = deployment.id;

    const [ordinary] = await db.insert(organizations).values({ name: "Other org", slug: `other-${suffix}` }).returning({ id: organizations.id });
    ordinaryOrgId = ordinary.id;
    const [visibleCourse] = await db.insert(courses).values({ organizationId: deploymentOrgId, title: "Visible fixture", code: `VISIBLE-${suffix}`, term: "Autumn 2026" }).returning({ id: courses.id });
    visibleCourseId = visibleCourse.id;
    const [hiddenCourse] = await db.insert(courses).values({ organizationId: ordinaryOrgId, title: "Hidden fixture", code: `HIDDEN-${suffix}`, term: "Autumn 2026" }).returning({ id: courses.id });
    hiddenCourseId = hiddenCourse.id;

    const [signedIn] = await db.insert(users).values({
      email: await cipher.encryptString(`signed-${suffix}@uw.edu`),
      emailBlindIndex: await cipher.computeBlindIndex(`signed-${suffix}@uw.edu`),
      isPending: false,
      platformInstructorGrantedAt: new Date("2026-01-02T00:00:00Z"),
    }).returning({ id: users.id });
    signedInUserId = signedIn.id;
    const [pending] = await db.insert(users).values({
      email: await cipher.encryptString(`pending-${suffix}@uw.edu`),
      emailBlindIndex: await cipher.computeBlindIndex(`pending-${suffix}@uw.edu`),
      isPending: true,
      platformInstructorGrantedAt: new Date("2026-01-03T00:00:00Z"),
    }).returning({ id: users.id });
    pendingUserId = pending.id;
    const [secondInstructor] = await db.insert(users).values({
      email: await cipher.encryptString(`second-${suffix}@uw.edu`),
      emailBlindIndex: await cipher.computeBlindIndex(`second-${suffix}@uw.edu`),
      isPending: true,
    }).returning({ id: users.id });
    secondInstructorId = secondInstructor.id;
    await db.insert(courseMemberships).values([
      { courseId: visibleCourseId, userId: signedInUserId, role: "instructor" },
      { courseId: visibleCourseId, userId: secondInstructorId, role: "instructor" },
      { courseId: hiddenCourseId, userId: pendingUserId, role: "instructor" },
    ]);
  });

  afterAll(async () => {
    await db.delete(courses).where(eq(courses.id, visibleCourseId));
    await db.delete(organizations).where(eq(organizations.id, ordinaryOrgId));
    await db.delete(users).where(eq(users.id, signedInUserId));
    await db.delete(users).where(eq(users.id, pendingUserId));
    await db.delete(users).where(eq(users.id, secondInstructorId));
  });

  it("lists only deployment courses and decrypts their active instructor emails", async () => {
    const result = await listPlatformCourses(db, cipher);
    const visible = result.find((course) => course.id === visibleCourseId);
    expect(visible).toMatchObject({ title: "Visible fixture", status: "active" });
    expect(visible?.instructors).toEqual([
      { userId: signedInUserId, email: `signed-${suffix}@uw.edu` },
      { userId: secondInstructorId, email: `second-${suffix}@uw.edu` },
    ].sort((a, b) => a.email.localeCompare(b.email)));
    expect(result.some((course) => course.id === hiddenCourseId)).toBe(false);
  });

  it("lists every platform grant with sign-in state and deployment-course count", async () => {
    const result = await listPlatformInstructors(db, cipher);
    expect(result.find((instructor) => instructor.userId === signedInUserId)).toMatchObject({
      email: `signed-${suffix}@uw.edu`, status: "signed_in", assignedCourseCount: 1,
    });
    expect(result.find((instructor) => instructor.userId === pendingUserId)).toMatchObject({
      email: `pending-${suffix}@uw.edu`, status: "pending", assignedCourseCount: 0,
    });
  });
});
