import { describe, it, expect, beforeAll } from "vitest";
import { makeNodeDb } from "../../db/nodeClient";
import type { Db } from "../../db/client";
import { organizations, courses, users, courseMemberships } from "../../db/schema";
import { unsafeCourseScope } from "./scope";
import { listCourseTas, setTaCapabilities } from "./courseMemberships";

const DATABASE_URL = process.env.DATABASE_URL;

/** #172: the capability grant is a security boundary -- an instructor of one
 *  course must not be able to grant capabilities on another course's TA, and
 *  a non-TA membership must never pick up these flags. Both are enforced in
 *  the WHERE clause rather than a read-then-write check, so they're tested
 *  against a real database rather than a mock that would just echo back
 *  whatever the query builder was handed. */
describe.skipIf(!DATABASE_URL)("courseMemberships repository (#172)", () => {
  let db: Db;
  let courseAId: string;
  let courseBId: string;
  let taAMembershipId: string;
  let taBMembershipId: string;
  let instructorMembershipId: string;
  let droppedTaMembershipId: string;

  async function makeUser(): Promise<string> {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const [u] = await db
      .insert(users)
      .values({ email: bytes as never, emailBlindIndex: bytes as never })
      .returning({ id: users.id });
    return u!.id;
  }

  beforeAll(async () => {
    db = makeNodeDb(DATABASE_URL!);
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

  it("both capabilities default to false on a new TA membership", async () => {
    const tas = await listCourseTas(db, unsafeCourseScope(courseAId));
    const ta = tas.find((t) => t.membershipId === taAMembershipId);
    expect(ta).toBeDefined();
    expect(ta!.canViewSolutions).toBe(false);
    expect(ta!.canViewDrafts).toBe(false);
  });

  it("lists only non-dropped TA memberships of the given course", async () => {
    const ids = (await listCourseTas(db, unsafeCourseScope(courseAId))).map((t) => t.membershipId);
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
    const [row] = await listCourseTas(db, unsafeCourseScope(courseBId));
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

  it("reads back the current row when no flags are supplied, without an empty UPDATE", async () => {
    const result = await setTaCapabilities(db, unsafeCourseScope(courseAId), taAMembershipId, {});
    expect(result).not.toBeNull();
    expect(result!.membershipId).toBe(taAMembershipId);
  });
});
