import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { Db } from "../../db/client";
import * as schema from "../../db/schema";
import { courseMemberships, courses, organizations, users } from "../../db/schema";
import { runMigrations } from "../../../scripts/migrate";
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
  const databaseName = `llteacher_listings_test_${suffix.replace(/-/g, "")}`;
  let adminPool: Pool;
  let fixturePool: Pool | undefined;
  let databaseCreated = false;

  beforeAll(async () => {
    // Listings read the deployment singleton and every platform grant. Give
    // this suite its own database so other suites' organizations and cipher
    // keys cannot affect it, regardless of seed data or parallel execution.
    adminPool = new Pool({ connectionString: DATABASE_URL! });
    await adminPool.query(`CREATE DATABASE ${databaseName}`);
    databaseCreated = true;
    const fixtureUrl = new URL(DATABASE_URL!);
    fixtureUrl.pathname = `/${databaseName}`;
    await runMigrations(fixtureUrl.toString());
    fixturePool = new Pool({ connectionString: fixtureUrl.toString() });
    db = drizzle(fixturePool, { schema }) as Db;
    cipher = new IdentityCipher(await loadIdentityCipherKeys({
      ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
      BLIND_INDEX_KEY: process.env.BLIND_INDEX_KEY ?? Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
    } as Env));
    const [deployment] = await db.insert(organizations).values({
      name: "Deployment fixture",
      slug: `deployment-${suffix}`,
      deploymentSingleton: true,
    }).returning({ id: organizations.id });
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
  }, 60_000);

  afterAll(async () => {
    try {
      await fixturePool?.end();
      if (databaseCreated) await adminPool.query(`DROP DATABASE ${databaseName}`);
    } finally {
      await adminPool.end();
    }
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
      assignedCourses: [{ code: `VISIBLE-${suffix}`, term: "Autumn 2026" }],
    });
    expect(result.find((instructor) => instructor.userId === pendingUserId)).toMatchObject({
      email: `pending-${suffix}@uw.edu`, status: "pending", assignedCourseCount: 0, assignedCourses: [],
    });
  });
});
