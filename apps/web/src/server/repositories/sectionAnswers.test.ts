import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { makeNodeDb } from "../../db/nodeClient";
import type { Db } from "../../db/client";
import { organizations, courses, users, homeworks, sections, courseMemberships } from "../../db/schema";
import { unsafeOrgScope, unsafeCourseScope } from "./scope";
import { upsertSectionAnswer, getSectionAnswer } from "./sectionAnswers";

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)("sectionAnswers repository", () => {
  let db: Db;
  let orgAId: string;
  let orgBId: string;
  let courseAId: string;
  let courseA2Id: string;
  let membershipAId: string;
  let studentId: string;
  let unenrolledStudentId: string;
  let droppedStudentId: string;

  beforeAll(async () => {
    db = makeNodeDb(DATABASE_URL!);
    const [orgA] = await db
      .insert(organizations)
      .values({ slug: `sa-repo-a-${crypto.randomUUID()}`, name: "A", workosOrganizationId: `w-a-${crypto.randomUUID()}` })
      .returning({ id: organizations.id });
    orgAId = orgA.id;
    const [orgB] = await db
      .insert(organizations)
      .values({ slug: `sa-repo-b-${crypto.randomUUID()}`, name: "B", workosOrganizationId: `w-b-${crypto.randomUUID()}` })
      .returning({ id: organizations.id });
    orgBId = orgB.id;
    const [courseA] = await db
      .insert(courses)
      .values({ organizationId: orgAId, code: "C", term: "T", title: "T" })
      .returning({ id: courses.id });
    courseAId = courseA.id;
    // #174: a second course in the SAME org -- distinct from orgB, which
    // only proves cross-org isolation. This is what tests the actual bug
    // (courseId-authorized, org-scoped query).
    const [courseA2] = await db
      .insert(courses)
      .values({ organizationId: orgAId, code: "C2", term: "T", title: "T2" })
      .returning({ id: courses.id });
    courseA2Id = courseA2.id;

    const emailBytes = crypto.getRandomValues(new Uint8Array(32));
    const [userA] = await db
      .insert(users)
      .values({ email: emailBytes as never, emailBlindIndex: emailBytes as never })
      .returning({ id: users.id });
    const [membershipA] = await db
      .insert(courseMemberships)
      .values({ userId: userA.id, courseId: courseAId, role: "instructor" })
      .returning({ id: courseMemberships.id });
    membershipAId = membershipA.id;

    // #175: the student who actually writes -- a non-dropped student
    // membership in courseA, distinct from the instructor above (course
    // memberships are unique per (userId, courseId), so the creator can't
    // double as the writing student).
    const studentEmailBytes = crypto.getRandomValues(new Uint8Array(32));
    const [studentUser] = await db
      .insert(users)
      .values({ email: studentEmailBytes as never, emailBlindIndex: studentEmailBytes as never })
      .returning({ id: users.id });
    studentId = studentUser.id;
    await db.insert(courseMemberships).values({ userId: studentId, courseId: courseAId, role: "student" });

    const unenrolledEmailBytes = crypto.getRandomValues(new Uint8Array(32));
    const [unenrolledUser] = await db
      .insert(users)
      .values({ email: unenrolledEmailBytes as never, emailBlindIndex: unenrolledEmailBytes as never })
      .returning({ id: users.id });
    unenrolledStudentId = unenrolledUser.id;
    // No membership in courseA at all.

    const droppedEmailBytes = crypto.getRandomValues(new Uint8Array(32));
    const [droppedUser] = await db
      .insert(users)
      .values({ email: droppedEmailBytes as never, emailBlindIndex: droppedEmailBytes as never })
      .returning({ id: users.id });
    droppedStudentId = droppedUser.id;
    await db.insert(courseMemberships).values({ userId: droppedStudentId, courseId: courseAId, role: "student", droppedAt: new Date() });
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgAId));
    await db.delete(organizations).where(eq(organizations.id, orgBId));
  });

  async function newSection(
    type: "conversation" | "non_interactive" = "non_interactive",
    opts: { courseId?: string; isHidden?: boolean; expiresAt?: Date | null } = {},
  ) {
    const [hw] = await db
      .insert(homeworks)
      .values({
        courseId: opts.courseId ?? courseAId,
        createdById: membershipAId,
        title: "h",
        description: "d",
        dueDate: new Date(),
        isHidden: opts.isHidden ?? false,
        expiresAt: opts.expiresAt ?? null,
      })
      .returning({ id: homeworks.id });
    const [section] = await db
      .insert(sections)
      .values({ homeworkId: hw.id, order: 1, title: "s", content: "c", type })
      .returning({ id: sections.id });
    return section.id;
  }

  it("first submit creates a row", async () => {
    const sectionId = await newSection();
    const answer = await upsertSectionAnswer(db, unsafeOrgScope(orgAId), sectionId, studentId, "my answer");
    expect(answer.content).toBe("my answer");
    expect(answer.sectionId).toBe(sectionId);
    expect(answer.userId).toBe(studentId);
  });

  it("second submit for the same (user, section) updates the same row, not a new one", async () => {
    const sectionId = await newSection();
    const first = await upsertSectionAnswer(db, unsafeOrgScope(orgAId), sectionId, studentId, "first");
    const second = await upsertSectionAnswer(db, unsafeOrgScope(orgAId), sectionId, studentId, "revised");
    expect(second.id).toBe(first.id);
    expect(second.content).toBe("revised");

    const fetched = await getSectionAnswer(db, unsafeCourseScope(courseAId), sectionId, studentId);
    expect(fetched!.content).toBe("revised");
  });

  it("throws when submitting against a conversation-type section", async () => {
    const sectionId = await newSection("conversation");
    await expect(
      upsertSectionAnswer(db, unsafeOrgScope(orgAId), sectionId, studentId, "answer"),
    ).rejects.toThrow(/does not accept a direct answer/i);
  });

  it("throws when the section belongs to a different org's course", async () => {
    const sectionId = await newSection();
    await expect(
      upsertSectionAnswer(db, unsafeOrgScope(orgBId), sectionId, studentId, "answer"),
    ).rejects.toThrow(/not found in this org scope/i);
  });

  it("getSectionAnswer returns null when none exists", async () => {
    const sectionId = await newSection();
    const result = await getSectionAnswer(db, unsafeCourseScope(courseAId), sectionId, studentId);
    expect(result).toBeNull();
  });

  // #174: the actual regression -- a section in a *different course of the
  // same org* must be unreachable through a courseA-scoped instructor read,
  // not just a different org's.
  it("getSectionAnswer returns null for a section belonging to a different course in the same org", async () => {
    const sectionId = await newSection("non_interactive", { courseId: courseA2Id });
    await db.insert(courseMemberships).values({ userId: studentId, courseId: courseA2Id, role: "student" }).onConflictDoNothing();
    // Write the answer under courseA2's own scope so it exists at all.
    await upsertSectionAnswer(db, unsafeOrgScope(orgAId), sectionId, studentId, "answer in course A2");
    const result = await getSectionAnswer(db, unsafeCourseScope(courseAId), sectionId, studentId);
    expect(result).toBeNull();
  });

  // #175: the caller has no student membership in the section's course at all.
  it("throws when the calling user has no membership in the section's course", async () => {
    const sectionId = await newSection();
    await expect(
      upsertSectionAnswer(db, unsafeOrgScope(orgAId), sectionId, unenrolledStudentId, "answer"),
    ).rejects.toThrow(/not found in this org scope/i);
  });

  // #175: dropped enrollment must not still count (#139's droppedAt gate).
  it("throws when the calling user's membership in the section's course has been dropped", async () => {
    const sectionId = await newSection();
    await expect(
      upsertSectionAnswer(db, unsafeOrgScope(orgAId), sectionId, droppedStudentId, "answer"),
    ).rejects.toThrow(/not found in this org scope/i);
  });

  // #177: a manually hidden homework blocks the write, matching the read side.
  it("throws when the parent homework is manually hidden", async () => {
    const sectionId = await newSection("non_interactive", { isHidden: true });
    await expect(
      upsertSectionAnswer(db, unsafeOrgScope(orgAId), sectionId, studentId, "answer"),
    ).rejects.toThrow(/hidden or expired/i);
  });

  // #177: a passed expiresAt blocks the write even though isHidden is false.
  it("throws when the parent homework's expiresAt has passed", async () => {
    const sectionId = await newSection("non_interactive", { expiresAt: new Date(Date.now() - 60_000) });
    await expect(
      upsertSectionAnswer(db, unsafeOrgScope(orgAId), sectionId, studentId, "answer"),
    ).rejects.toThrow(/hidden or expired/i);
  });

  it("does not block a write when expiresAt is in the future", async () => {
    const sectionId = await newSection("non_interactive", { expiresAt: new Date(Date.now() + 60_000) });
    const answer = await upsertSectionAnswer(db, unsafeOrgScope(orgAId), sectionId, studentId, "answer");
    expect(answer.content).toBe("answer");
  });
});
