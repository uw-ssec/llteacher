/* --------------------------------------------------------------------------
   #32 / #86: the roster and its one provisioning pipeline.

   Real-DB, for the reason the sibling suites are: the design rests on
   `course_memberships_user_course_uq` spanning dropped rows (which makes
   enrolment an upsert, not an insert) and on #207's capability constraint
   rejecting a restore that forgets to clear grants. A mock evaluates
   neither, so a mocked version of these would pass either way.
   -------------------------------------------------------------------------- */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { makeNodeDb } from "../../db/nodeClient";
import type { Db } from "../../db/client";
import { courseMemberships, courses, organizations, users } from "../../db/schema";
import { unsafeCourseScope } from "./scope";
import {
  allowedDomainsForCourse,
  listCourseRoster,
  previewCourseMembers,
  removeCourseMember,
  upsertCourseMember,
  upsertCourseMembers,
} from "./roster";
import { loadIdentityCipherKeys } from "../../lib/secrets-loader";
import { IdentityCipher } from "../../lib/crypto/identity-cipher";

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)("roster provisioning (#32, #86)", () => {
  let db: Db;
  let cipher: IdentityCipher;
  let courseId: string;
  let otherCourseId: string;
  let orgId: string;

  const email = () => `s-${crypto.randomUUID().slice(0, 8)}@uw.edu`;
  const scope = () => unsafeCourseScope(courseId);
  const UW = ["uw.edu"];

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
        slug: `r-${crypto.randomUUID()}`,
        name: "Roster org",
        workosOrganizationId: `w-${crypto.randomUUID()}`,
        allowedDomains: ["uw.edu"],
      })
      .returning({ id: organizations.id });
    orgId = org!.id;
    const [course] = await db
      .insert(courses)
      .values({ organizationId: orgId, code: "R1", term: "T", title: "Roster" })
      .returning({ id: courses.id });
    courseId = course!.id;
    const [other] = await db
      .insert(courses)
      .values({ organizationId: orgId, code: "R2", term: "T", title: "Other" })
      .returning({ id: courses.id });
    otherCourseId = other!.id;
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  it("creates a pending user and an ungranted membership for a new address", async () => {
    const addr = email();
    const result = await upsertCourseMember(db, scope(), cipher, { email: addr, role: "student" }, UW);
    expect(result.status).toBe("added");

    const { members } = await listCourseRoster(db, scope(), cipher, { search: addr });
    const member = members.find((m) => m.email === addr)!;
    // Pending, so the console can say "waiting for them to sign in" rather
    // than implying something is broken.
    expect(member.status).toBe("pending");
    expect(member.lastLoginAt).toBeNull();
    expect(member.role).toBe("student");
  });

  it("derives and stores the NetID for a uw.edu address", async () => {
    // The #210 admin search keys on netid_blind_index; waiting for a first
    // login to populate it would make a just-imported student unfindable.
    const addr = `netid${crypto.randomUUID().slice(0, 4)}@uw.edu`;
    await upsertCourseMember(db, scope(), cipher, { email: addr, role: "student" }, UW);
    const local = addr.split("@")[0]!;
    const found = await db.query.users.findFirst({
      where: eq(users.netidBlindIndex, await cipher.computeBlindIndex(local)),
    });
    expect(found).toBeDefined();
  });

  it("reports an address outside the allowlist without creating anything", async () => {
    const addr = "someone@gmail.com";
    const result = await upsertCourseMember(db, scope(), cipher, { email: addr, role: "student" }, UW);
    expect(result.status).toBe("disallowed_domain");
    // A junk user row would permanently squat a uniquely-indexed blind index.
    const found = await db.query.users.findFirst({
      where: eq(users.emailBlindIndex, await cipher.computeBlindIndex(addr)),
    });
    expect(found).toBeUndefined();
  });

  it("distinguishes a malformed address from a disallowed one", async () => {
    // The instructor needs different sentences for "you typed it wrong" and
    // "that person is not eligible".
    const result = await upsertCourseMember(db, scope(), cipher, { email: "not-an-email", role: "student" }, UW);
    expect(result.status).toBe("invalid_email");
  });

  it("re-importing is an upsert, never a duplicate", async () => {
    const addr = email();
    const first = await upsertCourseMember(db, scope(), cipher, { email: addr, role: "student" }, UW);
    const second = await upsertCourseMember(db, scope(), cipher, { email: addr, role: "student" }, UW);
    // course_memberships_user_course_uq spans dropped rows, so a second
    // insert would violate it -- this is the property that makes re-upload
    // safe.
    expect(second).toMatchObject({ status: "already_enrolled", membershipId: first.membershipId });
  });

  it("restores a removed member with capability flags cleared", async () => {
    const addr = email();
    const added = await upsertCourseMember(db, scope(), cipher, { email: addr, role: "ta" }, UW);
    await db
      .update(courseMemberships)
      .set({ canViewSolutions: true })
      .where(eq(courseMemberships.id, added.membershipId!));
    await removeCourseMember(db, scope(), added.membershipId!);

    const restored = await upsertCourseMember(db, scope(), cipher, { email: addr, role: "ta" }, UW);
    expect(restored).toMatchObject({ status: "restored", membershipId: added.membershipId });
    const row = await db.query.courseMemberships.findFirst({
      where: eq(courseMemberships.id, added.membershipId!),
    });
    // Re-adding someone must not silently re-grant the answer key.
    expect(row!.canViewSolutions).toBe(false);
    expect(row!.droppedAt).toBeNull();
  });

  it("refuses to change an active member's role rather than promoting them", async () => {
    const addr = email();
    await upsertCourseMember(db, scope(), cipher, { email: addr, role: "student" }, UW);
    const conflict = await upsertCourseMember(db, scope(), cipher, { email: addr, role: "ta" }, UW);
    // Changing a role changes what they can see of their own coursework;
    // that is an instructor's deliberate act, not a CSV side effect.
    expect(conflict).toMatchObject({ status: "role_conflict", existingRole: "student" });
  });

  it("shows dropped members, unlike every other membership read", async () => {
    const addr = email();
    const added = await upsertCourseMember(db, scope(), cipher, { email: addr, role: "student" }, UW);
    await removeCourseMember(db, scope(), added.membershipId!);

    const { members } = await listCourseRoster(db, scope(), cipher, { search: addr });
    const member = members.find((m) => m.membershipId === added.membershipId)!;
    // A removal that leaves no trace is indistinguishable from a person who
    // was never added -- and the roster is where that question gets asked.
    expect(member.status).toBe("dropped");
    expect(member.droppedAt).not.toBeNull();
  });

  it("will not remove an instructor, who would have nobody to add them back", async () => {
    const addr = email();
    const added = await upsertCourseMember(db, scope(), cipher, { email: addr, role: "student" }, UW);
    await db
      .update(courseMemberships)
      .set({ role: "instructor" })
      .where(eq(courseMemberships.id, added.membershipId!));

    expect((await removeCourseMember(db, scope(), added.membershipId!)).outcome).toBe(
      "is_instructor",
    );
    const row = await db.query.courseMemberships.findFirst({
      where: eq(courseMemberships.id, added.membershipId!),
    });
    expect(row!.droppedAt).toBeNull();
  });

  it("will not remove through another course's scope", async () => {
    const addr = email();
    const added = await upsertCourseMember(db, scope(), cipher, { email: addr, role: "student" }, UW);
    // The #174 lesson: course scope is in the WHERE clause, so this matches
    // zero rows rather than being read, checked, then written by id.
    const result = await removeCourseMember(db, unsafeCourseScope(otherCourseId), added.membershipId!);
    expect(result.outcome).toBe("not_found");
  });

  it("finds an exact email through the blind index, and a name after decryption", async () => {
    const addr = email();
    await upsertCourseMember(
      db,
      scope(),
      cipher,
      { email: addr, displayName: "Grace Hopper", role: "student" },
      UW,
    );
    // Exact-email search is an indexed equality on ciphertext.
    const byEmail = await listCourseRoster(db, scope(), cipher, { search: addr });
    expect(byEmail.members.some((m) => m.email === addr)).toBe(true);
    // Name search cannot be -- the column is encrypted, so it filters after
    // decryption over the course roster. See the performance note on the
    // function.
    const byName = await listCourseRoster(db, scope(), cipher, { search: "grace hopp" });
    expect(byName.members.some((m) => m.displayName === "Grace Hopper")).toBe(true);
  });

  it("derives initials for display without storing them", async () => {
    const addr = email();
    await upsertCourseMember(
      db,
      scope(),
      cipher,
      { email: addr, displayName: "Ada Lovelace", role: "student" },
      UW,
    );
    const { members } = await listCourseRoster(db, scope(), cipher, { search: addr });
    expect(members.find((m) => m.email === addr)!.initials).toBe("AL");
  });

  it("falls back to the platform allowlist when the org names none", async () => {
    const [bare] = await db
      .insert(organizations)
      .values({
        slug: `bare-${crypto.randomUUID()}`,
        name: "Bare",
        workosOrganizationId: `w-${crypto.randomUUID()}`,
      })
      .returning({ id: organizations.id });
    const [bareCourse] = await db
      .insert(courses)
      .values({ organizationId: bare!.id, code: "B", term: "T", title: "B" })
      .returning({ id: courses.id });

    expect(await allowedDomainsForCourse(db, unsafeCourseScope(bareCourse!.id))).toEqual(["uw.edu"]);
    await db.delete(organizations).where(eq(organizations.id, bare!.id));
  });

  it("keeps memberships in other courses untouched", async () => {
    const addr = email();
    const here = await upsertCourseMember(db, scope(), cipher, { email: addr, role: "student" }, UW);
    const there = await upsertCourseMember(
      db,
      unsafeCourseScope(otherCourseId),
      cipher,
      { email: addr, role: "ta" },
      UW,
    );
    // One identity, two memberships -- and the roster of one course never
    // shows the other's.
    expect(there.status).toBe("added");
    expect(there.membershipId).not.toBe(here.membershipId);
    const { members } = await listCourseRoster(db, scope(), cipher, { search: addr });
    expect(members.filter((m) => m.email === addr)).toHaveLength(1);

    const rows = await db.query.courseMemberships.findMany({
      where: and(eq(courseMemberships.courseId, courseId)),
    });
    expect(rows.every((r) => r.courseId === courseId)).toBe(true);
  });
});

/* --------------------------------------------------------------------------
   #355: the batched provisioning path.

   The single-entry `upsertCourseMember` is the manual-add door and one row
   is one row. It could not be a loop body: each call issues two to four
   SEQUENTIAL round trips, and on Workers every neon-http query is a
   subrequest, capped per invocation. A 300-student import -- the size #86
   exists to serve -- issued ~900 and exceeded both the cap and the wall
   clock, leaving a half-written roster.

   These assert the batch produces the SAME outcomes as the single path, in
   input order, because a faster path that disagrees with the one it replaced
   is not a fix.
   -------------------------------------------------------------------------- */
describe.skipIf(!DATABASE_URL)("upsertCourseMembers / previewCourseMembers (#355)", () => {
  let db: Db;
  let cipher: IdentityCipher;
  let courseId: string;
  let orgId: string;

  const scope = () => unsafeCourseScope(courseId);
  const UW = ["uw.edu"];
  const email = () => `b-${crypto.randomUUID().slice(0, 8)}@uw.edu`;

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
        slug: `b-${crypto.randomUUID()}`,
        name: "Batch org",
        workosOrganizationId: `w-${crypto.randomUUID()}`,
        allowedDomains: ["uw.edu"],
      })
      .returning({ id: organizations.id });
    orgId = org!.id;
    const [course] = await db
      .insert(courses)
      .values({ organizationId: orgId, code: "B1", term: "T", title: "Batch" })
      .returning({ id: courses.id });
    courseId = course!.id;
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  it("returns one result per entry, in input order, mixing every outcome", async () => {
    const fresh = email();
    const existing = email();
    const dropped = email();
    const conflicting = email();

    // Pre-existing states the batch must recognise.
    await upsertCourseMember(db, scope(), cipher, { email: existing, role: "student" }, UW);
    const droppedRow = await upsertCourseMember(db, scope(), cipher, { email: dropped, role: "student" }, UW);
    await removeCourseMember(db, scope(), droppedRow.membershipId!);
    await upsertCourseMember(db, scope(), cipher, { email: conflicting, role: "ta" }, UW);

    const entries = [
      { email: fresh, role: "student" as const },
      { email: existing, role: "student" as const },
      { email: dropped, role: "student" as const },
      { email: conflicting, role: "student" as const },
      { email: "nope@gmail.com", role: "student" as const },
      { email: "not-an-email", role: "student" as const },
    ];

    const results = await upsertCourseMembers(db, scope(), cipher, entries, UW);
    // Order is load-bearing: the route zips these back onto CSV rows by
    // position to report a spreadsheet line number.
    expect(results.map((r) => r.status)).toEqual([
      "added",
      "already_enrolled",
      "restored",
      "role_conflict",
      "disallowed_domain",
      "invalid_email",
    ]);
    expect(results[3]!.existingRole).toBe("ta");
  });

  it("agrees with the single-entry path it replaced", async () => {
    const viaBatch = email();
    const viaSingle = email();
    const [batched] = await upsertCourseMembers(
      db,
      scope(),
      cipher,
      [{ email: viaBatch, displayName: "Batched Person", role: "student" }],
      UW,
    );
    const single = await upsertCourseMember(
      db,
      scope(),
      cipher,
      { email: viaSingle, displayName: "Single Person", role: "student" },
      UW,
    );
    expect(batched!.status).toBe(single.status);

    // And the ROWS agree, not just the statuses: pending, ungranted, named.
    for (const [addr, name] of [
      [viaBatch, "Batched Person"],
      [viaSingle, "Single Person"],
    ] as const) {
      const { members } = await listCourseRoster(db, scope(), cipher, { search: addr });
      const member = members.find((m) => m.email === addr)!;
      expect(member.status).toBe("pending");
      expect(member.displayName).toBe(name);
      expect(member.role).toBe("student");
    }
  });

  it("clears capability flags on a batched restore", async () => {
    const addr = email();
    const added = await upsertCourseMember(db, scope(), cipher, { email: addr, role: "ta" }, UW);
    await db
      .update(courseMemberships)
      .set({ canViewSolutions: true })
      .where(eq(courseMemberships.id, added.membershipId!));
    await removeCourseMember(db, scope(), added.membershipId!);

    const [restored] = await upsertCourseMembers(
      db,
      scope(),
      cipher,
      [{ email: addr, role: "ta" }],
      UW,
    );
    expect(restored!.status).toBe("restored");
    const row = await db.query.courseMemberships.findFirst({
      where: eq(courseMemberships.id, added.membershipId!),
    });
    // Re-adding someone must not silently re-grant the answer key -- and
    // since #207 the database refuses a dropped row that still carries one,
    // so a restore that forgot would fail rather than be quietly wrong.
    expect(row!.canViewSolutions).toBe(false);
    expect(row!.droppedAt).toBeNull();
  });

  it("creates each identity once when the same address appears twice", async () => {
    // The route deduplicates before batching, but the repository must not
    // rely on that -- a duplicated entry would otherwise insert two users
    // racing for one uniquely-indexed email_blind_index.
    const addr = email();
    const results = await upsertCourseMembers(
      db,
      scope(),
      cipher,
      [
        { email: addr, role: "student" },
        { email: addr.toUpperCase(), role: "student" },
      ],
      UW,
    );
    expect(results).toHaveLength(2);
    const rows = await db.query.users.findMany({
      where: eq(users.emailBlindIndex, await cipher.computeBlindIndex(addr)),
    });
    expect(rows).toHaveLength(1);
  });

  it("previews without writing anything", async () => {
    const addr = email();
    const preview = await previewCourseMembers(
      db,
      scope(),
      cipher,
      [{ email: addr, role: "student" }],
      UW,
    );
    expect(preview[0]!.status).toBe("added");
    // Nothing was created: the preview's whole promise.
    const found = await db.query.users.findFirst({
      where: eq(users.emailBlindIndex, await cipher.computeBlindIndex(addr)),
    });
    expect(found).toBeUndefined();
  });

  it("previews the same outcomes the commit then produces", async () => {
    const fresh = email();
    const existing = email();
    await upsertCourseMember(db, scope(), cipher, { email: existing, role: "student" }, UW);

    const entries = [
      { email: fresh, role: "student" as const },
      { email: existing, role: "student" as const },
      { email: "nope@gmail.com", role: "student" as const },
    ];
    const previewed = await previewCourseMembers(db, scope(), cipher, entries, UW);
    const committed = await upsertCourseMembers(db, scope(), cipher, entries, UW);
    // The promise the preview makes. A separate validator is free to
    // disagree with the real path; sharing the classification is what stops
    // a commit doing something the preview did not say it would.
    expect(previewed.map((r) => r.status)).toEqual(committed.map((r) => r.status));
  });

  it("survives a concurrent import that creates the same identity first", async () => {
    // Two instructors importing overlapping rosters at the same moment both
    // pass the identity lookup and both try to insert. Because the batch is
    // ONE statement for the whole file, an unhandled conflict would take
    // down an import of three hundred rows over one shared address.
    const shared = email();
    const mine = email();
    const results = await Promise.all([
      upsertCourseMembers(db, scope(), cipher, [
        { email: shared, role: "student" },
        { email: mine, role: "student" },
      ], UW),
      upsertCourseMembers(db, scope(), cipher, [{ email: shared, role: "student" }], UW),
    ]);

    // Both imports succeeded, and neither reports a failure for the shared
    // address -- it is either newly added or already there, depending on who
    // won, and both are true answers.
    for (const batch of results) {
      for (const r of batch) {
        expect(["added", "already_enrolled"]).toContain(r.status);
      }
    }
    // One identity, not two.
    const rows = await db.query.users.findMany({
      where: eq(users.emailBlindIndex, await cipher.computeBlindIndex(shared)),
    });
    expect(rows).toHaveLength(1);
  });

  it("handles a batch far larger than any per-row path could", async () => {
    // 200 entries: ~600 sequential round trips under the old shape, which is
    // over the Worker subrequest cap. Here it is a handful of statements.
    const entries = Array.from({ length: 200 }, () => ({
      email: email(),
      role: "student" as const,
    }));
    const results = await upsertCourseMembers(db, scope(), cipher, entries, UW);
    expect(results).toHaveLength(200);
    expect(results.every((r) => r.status === "added")).toBe(true);
  });
});
