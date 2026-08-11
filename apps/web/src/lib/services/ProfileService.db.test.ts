/* --------------------------------------------------------------------------
   ProfileService against a real Postgres (#172 re-audit, FUN-102 / FUN-103).

   Why this file exists: ProfileService.test.ts hand-rolls its `db`, and a
   hand-rolled mock cannot interpret a SQL predicate. The FUN-007 test there
   returns only live rows -- exactly what the filtered query would -- so
   deleting `isNull(courseMemberships.droppedAt)` from the real query left it
   green. Same for the ORDER BY: a mock returns the array it was given, so no
   mock can observe the ordering the database is asked for. Both are the
   authorization-shaped half of this service (`courses[0]` decides whether the
   console offers authoring at all), so "untestable with the mock" is not a
   reason to leave them untested -- it is a reason to test them here.

   Skipped without DATABASE_URL, matching every other real-DB suite in this
   repo. CI provides one.
   -------------------------------------------------------------------------- */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { ProfileService } from "./ProfileService";
import { IdentityCipher } from "../crypto/identity-cipher";
import { loadIdentityCipherKeys } from "../secrets-loader";
import { makeNodeDb } from "../../db/nodeClient";
import type { Db } from "../../db/client";
import { organizations, courses, users, courseMemberships } from "../../db/schema";

const RAW_DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!RAW_DATABASE_URL)("ProfileService (real DB, #172 re-audit)", () => {
  let db: Db;
  let cipher: IdentityCipher;
  let orgId: string;

  /** Each test builds its own user and courses under a shared throwaway org,
   *  torn down by the cascade in afterAll. */
  async function makeUser(email: string) {
    const encrypted = await cipher.encryptString(email);
    const blind = await cipher.computeBlindIndex(email);
    const [user] = await db
      .insert(users)
      .values({ email: encrypted, emailBlindIndex: blind })
      .returning({ id: users.id });
    return user.id;
  }

  async function makeCourse(title: string) {
    const [course] = await db
      .insert(courses)
      .values({ organizationId: orgId, code: `C-${crypto.randomUUID().slice(0, 8)}`, term: "T", title })
      .returning({ id: courses.id });
    return course.id;
  }

  beforeAll(async () => {
    db = makeNodeDb(RAW_DATABASE_URL!) as unknown as Db;
    cipher = new IdentityCipher(
      await loadIdentityCipherKeys({
        ENCRYPTION_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
        BLIND_INDEX_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
      } as Env),
    );
    const [org] = await db
      .insert(organizations)
      .values({
        slug: `profile-${crypto.randomUUID()}`,
        name: "ProfileService Test Org",
        workosOrganizationId: `w-${crypto.randomUUID()}`,
      })
      .returning({ id: organizations.id });
    orgId = org.id;
  });

  afterAll(async () => {
    if (orgId) await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  /** FUN-102: the mock-based test for this could not fail. Here the dropped
   *  row genuinely exists in the table, so the SQL predicate is the only
   *  thing keeping it out of the result. */
  it("excludes a dropped membership from role, courseCount and courses", async () => {
    const userId = await makeUser(`dropped-${crypto.randomUUID()}@uw.edu`);
    const live = await makeCourse("Live Course");
    const dropped = await makeCourse("Dropped Course");

    await db.insert(courseMemberships).values([
      { userId, courseId: live, role: "student" },
      {
        userId,
        courseId: dropped,
        role: "instructor",
        droppedAt: new Date(),
        droppedReason: "user_deprovisioned",
      },
    ]);

    const profile = await new ProfileService(cipher, db).getProfileWithStats(userId);

    // The dropped instructor membership must not survive anywhere: not in
    // the count, not as the priority-ranked primary role, and not as a
    // course the console could select and offer authoring on.
    expect(profile.courseCount).toBe(1);
    expect(profile.role).toBe("student");
    expect(profile.courses).toBeUndefined();
  });

  /** FUN-103: the case the first ordering fix got wrong. A grad student who
   *  TA'd an earlier course and now instructs their own must land on the
   *  course they instruct -- apps/admin selects courses[0] as the active
   *  course and there is no switcher until #70, so getting this wrong leaves
   *  them with no authoring anywhere and no way to reach it. */
  it("puts an authoring course first even when it was enrolled most recently", async () => {
    const userId = await makeUser(`grad-${crypto.randomUUID()}@uw.edu`);
    const taCourse = await makeCourse("Assisted Last Year");
    const ownCourse = await makeCourse("Instructs This Year");

    await db.insert(courseMemberships).values([
      // Enrolled EARLIER -- the ordering that used to win.
      {
        userId,
        courseId: taCourse,
        role: "ta",
        canViewSolutions: true,
        enrolledAt: new Date("2025-01-01T00:00:00.000Z"),
      },
      {
        userId,
        courseId: ownCourse,
        role: "instructor",
        enrolledAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]);

    const profile = await new ProfileService(cipher, db).getProfileWithStats(userId);

    expect(profile.courses?.[0]).toMatchObject({
      id: ownCourse,
      title: "Instructs This Year",
      role: "instructor",
    });
    // The TA course is still listed -- they do assist there -- just not first.
    expect(profile.courses?.map((c) => c.id)).toEqual([ownCourse, taCourse]);
  });

  /** The complement of the case above, and the one the ordering rule is
   *  really for: the TA course is the MOST RECENT, so recency alone would
   *  put it first and leave this instructor unable to author anywhere.
   *
   *  This is a deliberate tradeoff, not an oversight: it means someone
   *  currently assisting one course and instructing an older one lands on
   *  the older course. Until the real course switcher (#70) exists, a
   *  console that can author is strictly more recoverable than one that
   *  cannot -- they can still reach the TA course's submissions, but a TA
   *  console offers no route back to authoring. Revisit when #70 lands. */
  it("prefers an authoring course over a more recent TA course", async () => {
    const userId = await makeUser(`instructor-then-ta-${crypto.randomUUID()}@uw.edu`);
    const ownCourse = await makeCourse("Instructs, Older");
    const taCourse = await makeCourse("Assists, Newer");

    await db.insert(courseMemberships).values([
      { userId, courseId: ownCourse, role: "instructor", enrolledAt: new Date("2025-01-01T00:00:00.000Z") },
      { userId, courseId: taCourse, role: "ta", enrolledAt: new Date("2026-06-01T00:00:00.000Z") },
    ]);

    const profile = await new ProfileService(cipher, db).getProfileWithStats(userId);
    expect(profile.courses?.map((c) => c.id)).toEqual([ownCourse, taCourse]);
    expect(profile.courses?.[0].role).toBe("instructor");
  });

  it("orders two authoring courses most-recent-first", async () => {
    const userId = await makeUser(`multi-${crypto.randomUUID()}@uw.edu`);
    const older = await makeCourse("Older Course");
    const newer = await makeCourse("Newer Course");

    await db.insert(courseMemberships).values([
      { userId, courseId: older, role: "instructor", enrolledAt: new Date("2025-01-01T00:00:00.000Z") },
      { userId, courseId: newer, role: "instructor", enrolledAt: new Date("2026-01-01T00:00:00.000Z") },
    ]);

    const profile = await new ProfileService(cipher, db).getProfileWithStats(userId);
    // Within one authority tier the SQL ordering decides, and the current
    // term is the better default than whichever course they joined first.
    expect(profile.courses?.map((c) => c.id)).toEqual([newer, older]);
  });

  it("resolves a TA's stored grants onto their course entry", async () => {
    const userId = await makeUser(`ta-${crypto.randomUUID()}@uw.edu`);
    const courseId = await makeCourse("TA Course");

    await db.insert(courseMemberships).values({
      userId,
      courseId,
      role: "ta",
      canViewSolutions: true,
      canViewDrafts: false,
    });

    const profile = await new ProfileService(cipher, db).getProfileWithStats(userId);
    expect(profile.courses).toEqual([
      { id: courseId, title: "TA Course", role: "ta", canViewSolutions: true, canViewDrafts: false },
    ]);
  });

  /** #199 (#172 re-audit, MNT-022): the branch deciding whether
   *  `profile.courses` is populated at all must be derived from CONSOLE_ROLES,
   *  not a hand-written disjunction of role literals.
   *
   *  Parametrised over every console role precisely so that dropping one from
   *  the condition fails here. A literal list that forgets a role produces an
   *  empty courses array -> canAuthor false -> "No course found for your
   *  account yet" for a user who has courses. Silent, in the auth path, and
   *  caught by nothing else. */
  it.each(["instructor", "ta", "admin"] as const)(
    "populates courses for a %s membership",
    async (role) => {
      const userId = await makeUser(`${role}-tier-${crypto.randomUUID()}@uw.edu`);
      const courseId = await makeCourse(`${role} Course`);
      await db.insert(courseMemberships).values({ userId, courseId, role });

      const profile = await new ProfileService(cipher, db).getProfileWithStats(userId);
      expect(profile.courses?.map((c) => c.id)).toEqual([courseId]);
      expect(profile.courses?.[0].role).toBe(role);
    },
  );

  it.each(["student", "observer"] as const)(
    "leaves courses undefined for a %s membership",
    async (role) => {
      // The other half of the same gate: widening it must fail too.
      const userId = await makeUser(`${role}-tier-${crypto.randomUUID()}@uw.edu`);
      const courseId = await makeCourse(`${role} Course`);
      await db.insert(courseMemberships).values({ userId, courseId, role });

      const profile = await new ProfileService(cipher, db).getProfileWithStats(userId);
      expect(profile.courses).toBeUndefined();
    },
  );
});
