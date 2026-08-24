/* --------------------------------------------------------------------------
   #208: the TA capability CHECK constraint, asserted against a real Postgres.

   `course_memberships_capabilities_require_ta` (migration 0020, widened by
   0027 for #207) is the database's half of "a capability grant belongs only
   to an active TA membership". Nothing in the suite exercised it.

   courseMemberships.test.ts only drives `setTaCapabilities`, whose WHERE
   clause already filters `role = 'ta' AND dropped_at IS NULL` -- so the
   constraint could be dropped by a future migration and every one of those
   tests would still pass. They assert the application's filter, not the
   database's rule, and the whole point of the constraint is to hold when the
   application's filter is the thing that broke.

   That makes this necessarily a real-DB suite: a mocked db cannot evaluate a
   CHECK. Skipped without DATABASE_URL, matching every other real-DB suite
   here; CI provides one.
   -------------------------------------------------------------------------- */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { makeNodeDb } from "../../db/nodeClient";
import type { Db } from "../../db/client";
import { organizations, courses, users, courseMemberships } from "../../db/schema";

const RAW_DATABASE_URL = process.env.DATABASE_URL;

/** These fixtures never decrypt anything, so random bytes of the right
 *  shape satisfy the branded encrypted-column types. Same helper, same
 *  reasoning, as submissions.db.test.ts. */
function randomBytes(): never {
  return crypto.getRandomValues(new Uint8Array(16)) as never;
}

describe.skipIf(!RAW_DATABASE_URL)("TA capability CHECK constraint (real DB, #208)", () => {
  let db: Db;
  let courseId: string;
  let userId: string;
  const createdOrgIds: string[] = [];

  beforeAll(async () => {
    db = makeNodeDb(RAW_DATABASE_URL!);

    const [org] = await db
      .insert(organizations)
      .values({
        name: "208-org",
        slug: `s208-${crypto.randomUUID().slice(0, 8)}`,
        workosOrganizationId: `org_${crypto.randomUUID().slice(0, 8)}`,
      })
      .returning({ id: organizations.id });
    createdOrgIds.push(org!.id);

    const [course] = await db
      .insert(courses)
      .values({
        organizationId: org!.id,
        code: `C-${crypto.randomUUID().slice(0, 8)}`,
        term: "T",
        title: "208",
      })
      .returning({ id: courses.id });
    courseId = course!.id;

    const [user] = await db
      .insert(users)
      .values({
        // users are not org-scoped -- a membership is what ties an identity
        // to an organization (see schema/identity.ts).
        email: randomBytes(),
        emailBlindIndex: randomBytes(),
        displayName: randomBytes(),
      })
      .returning({ id: users.id });
    userId = user!.id;
  });

  afterAll(async () => {
    // Memberships cascade from the course, which cascades from the org; the
    // user row does not, since users are not org-scoped.
    for (const id of createdOrgIds) {
      await db.delete(organizations).where(eq(organizations.id, id));
    }
    if (userId) await db.delete(users).where(eq(users.id, userId));
  });

  /** Fresh granted-TA row per test, so a rejected write in one cannot
   *  change what the next one starts from. */
  async function grantedTa(): Promise<string> {
    await db.delete(courseMemberships).where(eq(courseMemberships.userId, userId));
    const [m] = await db
      .insert(courseMemberships)
      .values({
        userId,
        courseId,
        role: "ta",
        canViewSolutions: true,
        canViewDrafts: true,
      })
      .returning({ id: courseMemberships.id });
    return m!.id;
  }

  it("rejects a raw role change that would leave grants on a non-TA row", async () => {
    const id = await grantedTa();
    // Deliberately raw: no repository function writes `role` today, which is
    // exactly why the rule lives in the database. This is the write a future
    // role-change feature would make.
    await expect(
      db.update(courseMemberships).set({ role: "student" }).where(eq(courseMemberships.id, id)),
    ).rejects.toThrow(/course_memberships_capabilities_require_ta/);
  });

  it("rejects dropping a granted TA without clearing the grants (#207)", async () => {
    const id = await grantedTa();
    // A dropped row is invisible to listCourseTas, so a grant left on one is
    // both live and unrevokable through the product. 0027 made that
    // unrepresentable rather than merely avoided.
    await expect(
      db
        .update(courseMemberships)
        .set({ droppedAt: new Date(), droppedReason: "roster_removal" })
        .where(eq(courseMemberships.id, id)),
    ).rejects.toThrow(/course_memberships_capabilities_require_ta/);
  });

  it("accepts a role change that clears the grants in the same statement", async () => {
    const id = await grantedTa();
    await db
      .update(courseMemberships)
      .set({ role: "student", canViewSolutions: false, canViewDrafts: false })
      .where(eq(courseMemberships.id, id));
    const row = await db.query.courseMemberships.findFirst({
      where: eq(courseMemberships.id, id),
    });
    expect(row?.role).toBe("student");
    expect(row?.canViewSolutions).toBe(false);
  });

  it("accepts a drop that clears the grants in the same statement", async () => {
    const id = await grantedTa();
    // The shape both real drop paths use -- removeCourseTa (#210) and
    // deactivateByWorkosUserId (SEC-006).
    await db
      .update(courseMemberships)
      .set({
        droppedAt: new Date(),
        droppedReason: "roster_removal",
        canViewSolutions: false,
        canViewDrafts: false,
      })
      .where(eq(courseMemberships.id, id));
    const row = await db.query.courseMemberships.findFirst({
      where: eq(courseMemberships.id, id),
    });
    expect(row?.droppedAt).not.toBeNull();
    expect(row?.canViewDrafts).toBe(false);
  });

  it("rejects granting a capability to a student membership outright", async () => {
    await db.delete(courseMemberships).where(eq(courseMemberships.userId, userId));
    await expect(
      db.insert(courseMemberships).values({
        userId,
        courseId,
        role: "student",
        canViewSolutions: true,
      }),
    ).rejects.toThrow(/course_memberships_capabilities_require_ta/);
  });
});
