import { describe, it, expect, beforeAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { makeNodeDb } from "../../db/nodeClient";
import type { Db } from "../../db/client";
import { organizations, courses, users, courseMemberships } from "../../db/schema";
import { unsafeCourseScope } from "./scope";
import {
  addTasByNetid,
  listCourseTas,
  removeCourseTa,
  setTaCapabilities,
} from "./courseMemberships";
import { loadIdentityCipherKeys } from "../../lib/secrets-loader";
import { IdentityCipher } from "../../lib/crypto/identity-cipher";

const DATABASE_URL = process.env.DATABASE_URL;

/** #172: the capability grant is a security boundary -- an instructor of one
 *  course must not be able to grant capabilities on another course's TA, and
 *  a non-TA membership must never pick up these flags. Both are enforced in
 *  the WHERE clause rather than a read-then-write check, so they're tested
 *  against a real database rather than a mock that would just echo back
 *  whatever the query builder was handed. */
describe.skipIf(!DATABASE_URL)("courseMemberships repository (#172)", () => {
  let db: Db;
  let cipher: IdentityCipher;
  let courseAId: string;
  let courseBId: string;
  let taAMembershipId: string;
  let taBMembershipId: string;
  let instructorMembershipId: string;
  let droppedTaMembershipId: string;

  /** Real encrypted identity, so listCourseTas's decrypt path is exercised
   *  rather than stubbed -- #172 audit (USE-001) added the join + decrypt so
   *  an instructor sees names instead of UUIDs. */
  async function makeUser(displayName = "Ada Lovelace", email = `ta-${crypto.randomUUID()}@uw.edu`) {
    const [u] = await db
      .insert(users)
      .values({
        email: await cipher.encryptString(email),
        emailBlindIndex: await cipher.computeBlindIndex(IdentityCipher.normalizeEmail(email)),
        displayName: await cipher.encryptString(displayName),
      })
      .returning({ id: users.id });
    return u!.id;
  }

  beforeAll(async () => {
    db = makeNodeDb(DATABASE_URL!);
    cipher = new IdentityCipher(
      await loadIdentityCipherKeys({
        ENCRYPTION_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
        BLIND_INDEX_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
      } as Env),
    );
    const [org] = await db
      .insert(organizations)
      .values({
        slug: `cm-${crypto.randomUUID()}`,
        name: "Org",
        workosOrganizationId: `w-${crypto.randomUUID()}`,
      })
      .returning({ id: organizations.id });

    // Two courses in the SAME org: cross-org isolation is not the risk here,
    // cross-course-within-org is (the #174 lesson applied to writes).
    const [courseA] = await db
      .insert(courses)
      .values({ organizationId: org!.id, code: "A", term: "T", title: "A" })
      .returning({ id: courses.id });
    courseAId = courseA!.id;
    const [courseB] = await db
      .insert(courses)
      .values({ organizationId: org!.id, code: "B", term: "T", title: "B" })
      .returning({ id: courses.id });
    courseBId = courseB!.id;

    const [taA] = await db
      .insert(courseMemberships)
      .values({ userId: await makeUser(), courseId: courseAId, role: "ta" })
      .returning({ id: courseMemberships.id });
    taAMembershipId = taA!.id;

    const [taB] = await db
      .insert(courseMemberships)
      .values({ userId: await makeUser(), courseId: courseBId, role: "ta" })
      .returning({ id: courseMemberships.id });
    taBMembershipId = taB!.id;

    const [instructor] = await db
      .insert(courseMemberships)
      .values({ userId: await makeUser(), courseId: courseAId, role: "instructor" })
      .returning({ id: courseMemberships.id });
    instructorMembershipId = instructor!.id;

    const [droppedTa] = await db
      .insert(courseMemberships)
      .values({ userId: await makeUser(), courseId: courseAId, role: "ta", droppedAt: new Date() })
      .returning({ id: courseMemberships.id });
    droppedTaMembershipId = droppedTa!.id;
  });

  it("decrypts each TA's identity rather than returning a raw id", async () => {
    const tas = await listCourseTas(db, unsafeCourseScope(courseAId), cipher);
    const ta = tas.find((t) => t.membershipId === taAMembershipId);
    expect(ta!.displayName).toBe("Ada Lovelace");
    expect(ta!.email).toMatch(/@uw\.edu$/);
  });

  it("both capabilities default to false on a new TA membership", async () => {
    const tas = await listCourseTas(db, unsafeCourseScope(courseAId), cipher);
    const ta = tas.find((t) => t.membershipId === taAMembershipId);
    expect(ta).toBeDefined();
    expect(ta!.canViewSolutions).toBe(false);
    expect(ta!.canViewDrafts).toBe(false);
  });

  it("lists only non-dropped TA memberships of the given course", async () => {
    const ids = (await listCourseTas(db, unsafeCourseScope(courseAId), cipher)).map((t) => t.membershipId);
    expect(ids).toContain(taAMembershipId);
    expect(ids).not.toContain(instructorMembershipId); // not a TA
    expect(ids).not.toContain(droppedTaMembershipId); // dropped
    expect(ids).not.toContain(taBMembershipId); // other course
  });

  it("sets a single capability without disturbing the other", async () => {
    const updated = await setTaCapabilities(db, unsafeCourseScope(courseAId), taAMembershipId, {
      canViewSolutions: true,
    });
    expect(updated).not.toBeNull();
    expect(updated!.canViewSolutions).toBe(true);
    expect(updated!.canViewDrafts).toBe(false);

    const both = await setTaCapabilities(db, unsafeCourseScope(courseAId), taAMembershipId, {
      canViewDrafts: true,
    });
    expect(both!.canViewSolutions).toBe(true); // untouched by the second write
    expect(both!.canViewDrafts).toBe(true);
  });

  it("revokes a capability as well as granting it", async () => {
    const revoked = await setTaCapabilities(db, unsafeCourseScope(courseAId), taAMembershipId, {
      canViewSolutions: false,
    });
    expect(revoked!.canViewSolutions).toBe(false);
  });

  it("refuses to update a TA belonging to a different course in the same org", async () => {
    const result = await setTaCapabilities(db, unsafeCourseScope(courseAId), taBMembershipId, {
      canViewSolutions: true,
    });
    expect(result).toBeNull();

    // And the target row is genuinely untouched, not just unreported.
    const [row] = await listCourseTas(db, unsafeCourseScope(courseBId), cipher);
    expect(row!.canViewSolutions).toBe(false);
  });

  it("refuses to set capabilities on a non-TA membership", async () => {
    const result = await setTaCapabilities(db, unsafeCourseScope(courseAId), instructorMembershipId, {
      canViewSolutions: true,
    });
    expect(result).toBeNull();
  });

  it("refuses to set capabilities on a dropped TA membership", async () => {
    const result = await setTaCapabilities(db, unsafeCourseScope(courseAId), droppedTaMembershipId, {
      canViewDrafts: true,
    });
    expect(result).toBeNull();
  });

  it("returns null for a membership id that does not exist", async () => {
    const result = await setTaCapabilities(db, unsafeCourseScope(courseAId), crypto.randomUUID(), {
      canViewDrafts: true,
    });
    expect(result).toBeNull();
  });

  it("rejects a call naming no capability, rather than issuing an empty UPDATE", async () => {
    // Unreachable through the route (it 400s first); asserted so the
    // precondition is stated rather than silently relied upon.
    await expect(
      setTaCapabilities(db, unsafeCourseScope(courseAId), taAMembershipId, {}),
    ).rejects.toThrow(/at least one capability flag/);
  });
});

/* --------------------------------------------------------------------------
   #210: adding and removing course TAs by NetID.

   Real-DB, for the same reason the suite above is: the whole design rests on
   `course_memberships_user_course_uq` being on (user_id, course_id)
   regardless of dropped_at -- which is why adding a TA is an upsert and never
   an insert. A mock cannot evaluate a unique index, so a mocked version of
   these tests would pass whether or not the upsert branches exist.
   -------------------------------------------------------------------------- */
describe.skipIf(!DATABASE_URL)("addTasByNetid / removeCourseTa (#210)", () => {
  let db: Db;
  let cipher: IdentityCipher;
  let courseId: string;
  let otherCourseId: string;

  /** Fresh NetID per call so tests never contend for one blind-index row --
   *  `netid_blind_index` is uniquely indexed, so a shared fixture NetID would
   *  make these order-dependent. Kept inside the 1-8 char personal rule. */
  const freshNetid = () => `t${crypto.randomUUID().replace(/[^a-z0-9]/g, "").slice(0, 7)}`;

  beforeAll(async () => {
    db = makeNodeDb(DATABASE_URL!);
    cipher = new IdentityCipher(
      await loadIdentityCipherKeys({
        ENCRYPTION_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
        BLIND_INDEX_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
      } as Env),
    );
    const [org] = await db
      .insert(organizations)
      .values({
        slug: `cm210-${crypto.randomUUID()}`,
        name: "Org",
        workosOrganizationId: `w-${crypto.randomUUID()}`,
      })
      .returning({ id: organizations.id });
    const [course] = await db
      .insert(courses)
      .values({ organizationId: org!.id, code: "A210", term: "T", title: "A" })
      .returning({ id: courses.id });
    courseId = course!.id;
    const [other] = await db
      .insert(courses)
      .values({ organizationId: org!.id, code: "B210", term: "T", title: "B" })
      .returning({ id: courses.id });
    otherCourseId = other!.id;
  });

  it("creates a pending user and an ungranted TA membership for a new NetID", async () => {
    const netid = freshNetid();
    const [result] = await addTasByNetid(db, unsafeCourseScope(courseId), cipher, [netid]);
    expect(result).toMatchObject({ netid, status: "added" });

    const tas = await listCourseTas(db, unsafeCourseScope(courseId), cipher);
    const added = tas.find((t) => t.membershipId === result!.membershipId);
    // Pending, so the console can say "waiting for them to sign in".
    expect(added!.isPending).toBe(true);
    // Adding a TA never widens access on its own -- the grant is a separate,
    // separately-audited instructor decision.
    expect(added!.canViewSolutions).toBe(false);
    expect(added!.canViewDrafts).toBe(false);
    // The derived email is what createOrClaimUser will match on at first
    // login; without it the pending row could never be claimed.
    expect(added!.email).toBe(`${netid}@uw.edu`);
  });

  it("reuses the existing user when the same NetID is added to a second course", async () => {
    const netid = freshNetid();
    await addTasByNetid(db, unsafeCourseScope(courseId), cipher, [netid]);
    const [second] = await addTasByNetid(db, unsafeCourseScope(otherCourseId), cipher, [netid]);
    expect(second!.status).toBe("added");

    // One identity, two memberships -- not two pending users racing for one
    // uniquely-indexed netid_blind_index.
    const rows = await db.query.users.findMany({
      where: eq(users.netidBlindIndex, await cipher.computeBlindIndex(netid)),
    });
    expect(rows).toHaveLength(1);
  });

  it("reports already_ta without writing, for an existing active TA", async () => {
    const netid = freshNetid();
    const [first] = await addTasByNetid(db, unsafeCourseScope(courseId), cipher, [netid]);
    const [again] = await addTasByNetid(db, unsafeCourseScope(courseId), cipher, [netid]);
    expect(again).toMatchObject({ status: "already_ta", membershipId: first!.membershipId });
  });

  it("restores a removed TA with both grants cleared", async () => {
    const netid = freshNetid();
    const [added] = await addTasByNetid(db, unsafeCourseScope(courseId), cipher, [netid]);
    // Grant something, then remove them: the grant must not survive the
    // round trip and come back when they are re-added.
    await setTaCapabilities(db, unsafeCourseScope(courseId), added!.membershipId!, {
      canViewSolutions: true,
      canViewDrafts: true,
    });
    await removeCourseTa(db, unsafeCourseScope(courseId), added!.membershipId!);

    const [restored] = await addTasByNetid(db, unsafeCourseScope(courseId), cipher, [netid]);
    // Same row -- the (user, course) unique index means there is only ever
    // one, so this is an upsert and not a second membership.
    expect(restored).toMatchObject({ status: "restored", membershipId: added!.membershipId });
    const row = await db.query.courseMemberships.findFirst({
      where: eq(courseMemberships.id, added!.membershipId!),
    });
    expect(row!.droppedAt).toBeNull();
    expect(row!.droppedReason).toBeNull();
    expect(row!.canViewSolutions).toBe(false);
    expect(row!.canViewDrafts).toBe(false);
  });

  it("refuses to promote an active membership under another role", async () => {
    const netid = freshNetid();
    await addTasByNetid(db, unsafeCourseScope(courseId), cipher, [netid]);
    const blindIndex = await cipher.computeBlindIndex(netid);
    const user = await db.query.users.findFirst({ where: eq(users.netidBlindIndex, blindIndex) });
    // Make them a student of the course, as a grad student enrolled in the
    // course they TA would be.
    await db
      .update(courseMemberships)
      .set({ role: "student", canViewSolutions: false, canViewDrafts: false })
      .where(
        and(eq(courseMemberships.userId, user!.id), eq(courseMemberships.courseId, courseId)),
      );

    const [conflict] = await addTasByNetid(db, unsafeCourseScope(courseId), cipher, [netid]);
    // Refused, and told what they already are -- promoting would change what
    // they can see of their own coursework, with no way to explain or undo it.
    expect(conflict).toMatchObject({ status: "role_conflict", existingRole: "student" });
    const row = await db.query.courseMemberships.findFirst({
      where: and(eq(courseMemberships.userId, user!.id), eq(courseMemberships.courseId, courseId)),
    });
    expect(row!.role).toBe("student");
  });

  it("isolates per-NetID failures and creates nothing for an invalid one", async () => {
    const good = freshNetid();
    const bad = "ada lovelace@uw.edu";
    const results = await addTasByNetid(db, unsafeCourseScope(courseId), cipher, [good, bad]);
    // One collective failure would be unusable -- the instructor could not
    // tell which of the two was the typo.
    expect(results.map((r) => r.status)).toEqual(["added", "invalid_netid"]);
    // Nothing was minted for the invalid entry: a junk pending row would
    // permanently squat a uniquely-indexed netid_blind_index.
    const junk = await db.query.users.findFirst({
      where: eq(users.netidBlindIndex, await cipher.computeBlindIndex(bad)),
    });
    expect(junk).toBeUndefined();
  });

  it("deduplicates a pasted list rather than reporting already_ta against itself", async () => {
    const netid = freshNetid();
    const results = await addTasByNetid(db, unsafeCourseScope(courseId), cipher, [
      netid,
      ` ${netid.toUpperCase()} `,
      "",
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("added");
  });

  it("removes a TA softly, clearing grants and keeping the row", async () => {
    const netid = freshNetid();
    const [added] = await addTasByNetid(db, unsafeCourseScope(courseId), cipher, [netid]);
    const removed = await removeCourseTa(db, unsafeCourseScope(courseId), added!.membershipId!);
    expect(removed).toMatchObject({ membershipId: added!.membershipId });

    const row = await db.query.courseMemberships.findFirst({
      where: eq(courseMemberships.id, added!.membershipId!),
    });
    // The row survives -- submissions, grades and audit events reference it.
    expect(row).toBeDefined();
    expect(row!.droppedReason).toBe("roster_removal");
    expect(row!.canViewSolutions).toBe(false);
    // And it is gone from the instructor-facing list.
    const tas = await listCourseTas(db, unsafeCourseScope(courseId), cipher);
    expect(tas.some((t) => t.membershipId === added!.membershipId)).toBe(false);
  });

  it("will not remove a TA through another course's scope", async () => {
    const netid = freshNetid();
    const [added] = await addTasByNetid(db, unsafeCourseScope(courseId), cipher, [netid]);
    // The #174 lesson: course scope is in the WHERE clause, so this matches
    // zero rows rather than being read, checked, and written by id.
    const removed = await removeCourseTa(
      db,
      unsafeCourseScope(otherCourseId),
      added!.membershipId!,
    );
    expect(removed).toBeNull();
    const row = await db.query.courseMemberships.findFirst({
      where: eq(courseMemberships.id, added!.membershipId!),
    });
    expect(row!.droppedAt).toBeNull();
  });

  it("returns null when removing an already-removed TA", async () => {
    const netid = freshNetid();
    const [added] = await addTasByNetid(db, unsafeCourseScope(courseId), cipher, [netid]);
    await removeCourseTa(db, unsafeCourseScope(courseId), added!.membershipId!);
    expect(await removeCourseTa(db, unsafeCourseScope(courseId), added!.membershipId!)).toBeNull();
  });
});
