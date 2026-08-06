import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { makeNodeDb } from "../../db/nodeClient";
import type { Db } from "../../db/client";
import { organizations, courses, users, conversations, courseMemberships, grades, homeworks, sections } from "../../db/schema";
import { unsafeOrgScope, unsafeCourseScope } from "./scope";
import { createConversation, softDeleteConversation } from "./conversations";
import { createSubmission, getSubmissionByConversation, recordGrade, submitSection, getHomeworkSubmissionsMatrix } from "./submissions";
import { loadIdentityCipherKeys } from "../../lib/secrets-loader";
import { IdentityCipher } from "../../lib/crypto/identity-cipher";
import { createHomework, updateHomework, getHomeworkById } from "./homeworks";

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)("submissions repository", () => {
  let db: Db;
  let orgAId: string;
  let orgBId: string;
  let courseAId: string;
  let courseBId: string;
  let userAId: string;
  let userBId: string;
  let membershipAId: string;
  let membershipBId: string;
  let droppedMembershipAId: string;
  let studentMembershipAId: string;
  let membershipByCourse: Record<string, string>;

  beforeAll(async () => {
    db = makeNodeDb(DATABASE_URL!);
    async function seed(label: string) {
      const [org] = await db
        .insert(organizations)
        .values({ slug: `sub-repo-${label}-${crypto.randomUUID()}`, name: label, workosOrganizationId: `w-${label}-${crypto.randomUUID()}` })
        .returning({ id: organizations.id });
      const [course] = await db
        .insert(courses)
        .values({ organizationId: org.id, code: "C", term: "T", title: "T" })
        .returning({ id: courses.id });
      const emailBytes = crypto.getRandomValues(new Uint8Array(32));
      const [user] = await db
        .insert(users)
        .values({ email: emailBytes as never, emailBlindIndex: emailBytes as never })
        .returning({ id: users.id });
      const [membership] = await db
        .insert(courseMemberships)
        .values({ userId: user.id, courseId: course.id, role: "instructor" })
        .returning({ id: courseMemberships.id });
      return { orgId: org.id, courseId: course.id, userId: user.id, membershipId: membership.id };
    }
    const a = await seed("a");
    orgAId = a.orgId;
    courseAId = a.courseId;
    userAId = a.userId;
    membershipAId = a.membershipId;
    const b = await seed("b");
    orgBId = b.orgId;
    courseBId = b.courseId;
    userBId = b.userId;
    membershipBId = b.membershipId;
    membershipByCourse = { [courseAId]: membershipAId, [courseBId]: membershipBId };

    // A dropped instructor membership and an active student membership in
    // course A -- used to prove recordGrade's grader check rejects a
    // dropped grader (#139) and a non-instructor grader (#140).
    const droppedEmailBytes = crypto.getRandomValues(new Uint8Array(32));
    const [droppedUser] = await db
      .insert(users)
      .values({ email: droppedEmailBytes as never, emailBlindIndex: droppedEmailBytes as never })
      .returning({ id: users.id });
    const [droppedMembership] = await db
      .insert(courseMemberships)
      .values({ userId: droppedUser.id, courseId: courseAId, role: "instructor", droppedAt: new Date() })
      .returning({ id: courseMemberships.id });
    droppedMembershipAId = droppedMembership.id;

    const studentEmailBytes = crypto.getRandomValues(new Uint8Array(32));
    const [studentUser] = await db
      .insert(users)
      .values({ email: studentEmailBytes as never, emailBlindIndex: studentEmailBytes as never })
      .returning({ id: users.id });
    const [studentMembership] = await db
      .insert(courseMemberships)
      .values({ userId: studentUser.id, courseId: courseAId, role: "student" })
      .returning({ id: courseMemberships.id });
    studentMembershipAId = studentMembership.id;
  });

  afterAll(async () => {
    // Not load-bearing (#138): grades.organization_id is its own direct
    // CASCADE to organizations, so deleting the org would clear these rows
    // on its own without this pre-clear -- kept anyway as harmless
    // defense-in-depth / a self-documenting delete order.
    await db.delete(grades).where(eq(grades.organizationId, orgAId));
    await db.delete(grades).where(eq(grades.organizationId, orgBId));
    await db.delete(organizations).where(eq(organizations.id, orgAId));
    await db.delete(organizations).where(eq(organizations.id, orgBId));
  });

  // Each test creates its own fresh conversation (and, since #140,
  // section -- createSubmission now rejects `tutor`-kind conversations) to
  // submit against. A fresh section per call, not a shared one, because
  // conversations_owner_section_active_uq allows only one active
  // section-conversation per (owner, section); several tests reuse the same
  // owner. submissions.conversation_id is also unique, so reusing a shared
  // conversation fixture across multiple createSubmission() calls would
  // collide with an earlier test's row regardless.
  async function newConversation(courseId: string, ownerUserId: string) {
    const [hw] = await db
      .insert(homeworks)
      .values({ courseId, createdById: membershipByCourse[courseId], title: "h", description: "d", dueDate: new Date() })
      .returning({ id: homeworks.id });
    const [section] = await db
      .insert(sections)
      .values({ homeworkId: hw.id, order: 1, title: "s", content: "c" })
      .returning({ id: sections.id });
    const [conv] = await db
      .insert(conversations)
      .values({ ownerUserId, courseId, sectionId: section.id, kind: "section", title: "t" })
      .returning({ id: conversations.id });
    return conv.id;
  }

  it("createSubmission writes under the given org scope", async () => {
    const conversationId = await newConversation(courseAId, userAId);
    const created = await createSubmission(db, unsafeOrgScope(orgAId), conversationId);
    expect(created.organizationId).toBe(orgAId);
  });

  it("getSubmissionByConversation scoped to org B returns nothing for an org-A conversation", async () => {
    const conversationId = await newConversation(courseAId, userAId);
    await createSubmission(db, unsafeOrgScope(orgAId), conversationId);
    const result = await getSubmissionByConversation(db, unsafeOrgScope(orgBId), conversationId);
    expect(result).toBeUndefined();
  });

  it("cross-org isolation: creating submissions under both orgs, an org-A-scoped list never includes org-B rows", async () => {
    const conversationId = await newConversation(courseBId, userBId);
    await createSubmission(db, unsafeOrgScope(orgBId), conversationId);
    const found = await getSubmissionByConversation(db, unsafeOrgScope(orgAId), conversationId);
    expect(found).toBeUndefined();
  });

  // The graded_by_ai=true + grader_membership_id-set rejection is a DB
  // CHECK, exercised at the schema level in runtime.test.ts ("rejects a
  // grade that is both graded_by_ai and has a grader_membership_id") --
  // not repeated here since recordGrade does no such validation itself.
  it("recordGrade writes an AI grade with no grader", async () => {
    const conversationId = await newConversation(courseBId, userBId);
    const sub = await createSubmission(db, unsafeOrgScope(orgBId), conversationId);
    const grade = await recordGrade(db, unsafeOrgScope(orgBId), {
      submissionId: sub.id,
      gradedByAi: true,
      score: 0.9,
    });
    expect(grade.gradedByAi).toBe(true);
  });

  it("createSubmission rejects a conversation that belongs to a different org's course", async () => {
    const conversationId = await newConversation(courseBId, userBId);
    await expect(createSubmission(db, unsafeOrgScope(orgAId), conversationId)).rejects.toThrow();
  });

  it("createSubmission rejects a soft-deleted conversation (#140)", async () => {
    const conversationId = await newConversation(courseAId, userAId);
    await softDeleteConversation(db, unsafeCourseScope(courseAId), conversationId);
    await expect(createSubmission(db, unsafeOrgScope(orgAId), conversationId)).rejects.toThrow();
  });

  it("createSubmission rejects a tutor-kind conversation (#140)", async () => {
    const tutorConv = await createConversation(db, unsafeCourseScope(courseAId), {
      ownerUserId: userAId,
      sectionId: null,
      kind: "tutor",
      title: "tutor chat",
    });
    await expect(createSubmission(db, unsafeOrgScope(orgAId), tutorConv.id)).rejects.toThrow();
  });

  it("recordGrade rejects a submissionId that belongs to a different org (#140)", async () => {
    const conversationId = await newConversation(courseBId, userBId);
    const sub = await createSubmission(db, unsafeOrgScope(orgBId), conversationId);
    await expect(
      recordGrade(db, unsafeOrgScope(orgAId), { submissionId: sub.id, gradedByAi: true }),
    ).rejects.toThrow();
  });

  it("recordGrade rejects a graderMembershipId that isn't a member of the submission's course", async () => {
    const conversationId = await newConversation(courseAId, userAId);
    const sub = await createSubmission(db, unsafeOrgScope(orgAId), conversationId);
    await expect(
      recordGrade(db, unsafeOrgScope(orgAId), {
        submissionId: sub.id,
        gradedByAi: false,
        graderMembershipId: membershipBId,
      }),
    ).rejects.toThrow();
  });

  it("recordGrade rejects a dropped graderMembershipId (#139)", async () => {
    const conversationId = await newConversation(courseAId, userAId);
    const sub = await createSubmission(db, unsafeOrgScope(orgAId), conversationId);
    await expect(
      recordGrade(db, unsafeOrgScope(orgAId), {
        submissionId: sub.id,
        gradedByAi: false,
        graderMembershipId: droppedMembershipAId,
      }),
    ).rejects.toThrow();
  });

  it("recordGrade rejects a graderMembershipId with a non-instructor role (#140)", async () => {
    const conversationId = await newConversation(courseAId, userAId);
    const sub = await createSubmission(db, unsafeOrgScope(orgAId), conversationId);
    await expect(
      recordGrade(db, unsafeOrgScope(orgAId), {
        submissionId: sub.id,
        gradedByAi: false,
        graderMembershipId: studentMembershipAId,
      }),
    ).rejects.toThrow();
  });

  describe("submitSection", () => {
    it("creates a submission on first submit", async () => {
      const conversationId = await newConversation(courseAId, userAId);
      const result = await submitSection(db, unsafeOrgScope(orgAId), conversationId, userAId);
      expect(result.conversationId).toBe(conversationId);
      expect(result.isResubmission).toBe(false);
      expect(result.submittedAt).toBeInstanceOf(Date);
    });

    it("resubmit updates submittedAt and returns isResubmission=true", async () => {
      const conversationId = await newConversation(courseAId, userAId);
      const first = await submitSection(db, unsafeOrgScope(orgAId), conversationId, userAId);
      const second = await submitSection(db, unsafeOrgScope(orgAId), conversationId, userAId);
      expect(second.id).toBe(first.id); // same row, updated -- not a duplicate
      expect(second.isResubmission).toBe(true);
    });

    it("rejects when requesterId does not own the conversation", async () => {
      const conversationId = await newConversation(courseAId, userAId);
      await expect(
        submitSection(db, unsafeOrgScope(orgAId), conversationId, userBId),
      ).rejects.toThrow();
    });

    it("rejects a soft-deleted conversation", async () => {
      const conversationId = await newConversation(courseAId, userAId);
      await softDeleteConversation(db, unsafeCourseScope(courseAId), conversationId);
      await expect(
        submitSection(db, unsafeOrgScope(orgAId), conversationId, userAId),
      ).rejects.toThrow();
    });

    it("rejects a tutor-kind conversation (no section)", async () => {
      const tutorConv = await createConversation(db, unsafeCourseScope(courseAId), {
        ownerUserId: userAId,
        sectionId: null,
        kind: "tutor",
        title: "tutor chat",
      });
      await expect(
        submitSection(db, unsafeOrgScope(orgAId), tutorConv.id, userAId),
      ).rejects.toThrow();
    });
  });
});

describe.skipIf(!DATABASE_URL)("getHomeworkSubmissionsMatrix (real DB)", () => {
  async function seedMatrixFixture() {
    const db = makeNodeDb(DATABASE_URL!);
    const [org] = await db.insert(organizations).values({
      slug: `m3-test-19-${crypto.randomUUID()}`, name: "M3 Test Org 19", workosOrganizationId: `wo-19-${crypto.randomUUID()}`,
    }).returning();
    const [course] = await db.insert(courses).values({
      organizationId: org!.id, code: "TEST19", term: "Test", title: "Test Course 19",
    }).returning();

    const cipher = new IdentityCipher(await loadIdentityCipherKeys({
      ENCRYPTION_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
      BLIND_INDEX_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
    } as Env));

    async function seedStudent(displayName: string, email: string) {
      const [user] = await db.insert(users).values({
        email: await cipher.encryptString(email),
        emailBlindIndex: await cipher.computeBlindIndex(IdentityCipher.normalizeEmail(email)),
        displayName: await cipher.encryptString(displayName),
      }).returning();
      const [membership] = await db.insert(courseMemberships).values({
        userId: user!.id, courseId: course!.id, role: "student",
      }).returning();
      return { user: user!, membership: membership! };
    }

    const studentA = await seedStudent("Student Active", "active@test.example");
    const studentB = await seedStudent("Student Inactive", "inactive@test.example");
    const studentC = await seedStudent("Student Partial", "partial@test.example");

    const [instructorUser] = await db.insert(users).values({
      email: crypto.getRandomValues(new Uint8Array(32)) as never,
      emailBlindIndex: crypto.getRandomValues(new Uint8Array(32)) as never,
    }).returning();
    const [instructorMembership] = await db.insert(courseMemberships).values({
      userId: instructorUser!.id, courseId: course!.id, role: "instructor",
    }).returning();

    const scope = unsafeCourseScope(course!.id);
    const hw = await createHomework(db, scope, {
      createdById: instructorMembership!.id, title: "Matrix HW", description: "d", dueDate: new Date("2099-01-01"),
    });
    await updateHomework(db, scope, hw!.id, {
      sections: [
        { title: "Section 1", content: "c1", order: 1 },
        { title: "Section 2", content: "c2", order: 2 },
      ],
    });
    const withSections = await getHomeworkById(db, scope, hw!.id);
    const section1 = withSections!.sections.find((s) => s.title === "Section 1")!;
    const section2 = withSections!.sections.find((s) => s.title === "Section 2")!;

    // Student A: 2 conversations on section 1 (one soft-deleted), 1 submitted -> active.
    const [convA1] = await db.insert(conversations).values({
      ownerUserId: studentA.user.id, courseId: course!.id, sectionId: section1.id, kind: "section", title: "a1",
    }).returning();
    await db.insert(conversations).values({
      ownerUserId: studentA.user.id, courseId: course!.id, sectionId: section1.id, kind: "section", title: "a2-deleted",
      isDeleted: true, deletedAt: new Date(),
    });
    await createSubmission(db, unsafeOrgScope(org!.id), convA1!.id);

    // Student B: no conversations at all -> no_interaction.

    // Student C: 1 conversation on section 2, not submitted -> partial.
    await db.insert(conversations).values({
      ownerUserId: studentC.user.id, courseId: course!.id, sectionId: section2.id, kind: "section", title: "c1",
    });

    return { db, org: org!, course: course!, cipher, scope, homeworkId: hw!.id, section1, section2, studentA, studentB, studentC };
  }

  it("computes participation status and section cells for a 3-student x 2-section fixture", async () => {
    const { db, org, cipher, scope, homeworkId, section1, studentA, studentB, studentC } = await seedMatrixFixture();

    const matrix = await getHomeworkSubmissionsMatrix(db, scope, cipher, homeworkId);

    expect(matrix).not.toBeNull();
    expect(matrix!.sectionHeaders).toHaveLength(2);
    expect(matrix!.students).toHaveLength(3);

    const rowA = matrix!.students.find((s) => s.studentId === studentA.user.id)!;
    const rowB = matrix!.students.find((s) => s.studentId === studentB.user.id)!;
    const rowC = matrix!.students.find((s) => s.studentId === studentC.user.id)!;

    expect(rowA.participationStatus).toBe("active");
    expect(rowA.totalConversations).toBe(2); // includes the soft-deleted one
    const rowASection1Cell = rowA.sections.find((c) => c.sectionId === section1.id)!;
    expect(rowASection1Cell.status).toBe("submitted");
    expect(rowASection1Cell.hasDeletedConversation).toBe(true);
    expect(rowASection1Cell.conversationCount).toBe(2);

    expect(rowB.participationStatus).toBe("no_interaction");
    expect(rowB.totalConversations).toBe(0);

    expect(rowC.participationStatus).toBe("partial");
    expect(rowC.totalConversations).toBe(1);

    expect(matrix!.aggregateStats).toEqual({
      totalStudents: 3, activeStudents: 2, inactiveStudents: 1, totalSubmissions: 1, submissionRate: 67,
    });

    await db.delete(organizations).where(eq(organizations.id, org.id));
  });

  it("returns plaintext displayName/email, never ciphertext", async () => {
    const { db, org, cipher, scope, homeworkId, studentA } = await seedMatrixFixture();

    const matrix = await getHomeworkSubmissionsMatrix(db, scope, cipher, homeworkId);
    const rowA = matrix!.students.find((s) => s.studentId === studentA.user.id)!;

    expect(rowA.displayName).toBe("Student Active");
    expect(rowA.email).toBe("active@test.example");

    const serialized = JSON.stringify(matrix);
    // The raw encrypted column value for studentA's email/displayName must
    // never appear in the serialized response -- fetch it directly and
    // confirm its ciphertext bytes (base64'd for a substring check) aren't
    // present anywhere in the output.
    const [rawUser] = await db.select({ email: users.email }).from(users).where(eq(users.id, studentA.user.id));
    const ciphertextBase64 = Buffer.from(rawUser!.email).toString("base64");
    expect(serialized).not.toContain(ciphertextBase64);

    await db.delete(organizations).where(eq(organizations.id, org.id));
  });

  it("scopes roster to course_memberships, excludes a student not enrolled in this course", async () => {
    const { db, org, cipher, scope, homeworkId } = await seedMatrixFixture();
    const [outsideUser] = await db.insert(users).values({
      email: crypto.getRandomValues(new Uint8Array(32)) as never,
      emailBlindIndex: crypto.getRandomValues(new Uint8Array(32)) as never,
    }).returning();
    // Enrolled in a *different* course under the same org, not this homework's course.
    const [otherCourse] = await db.insert(courses).values({
      organizationId: org.id, code: "OTHER", term: "Test", title: "Other Course",
    }).returning();
    await db.insert(courseMemberships).values({ userId: outsideUser!.id, courseId: otherCourse!.id, role: "student" });

    const matrix = await getHomeworkSubmissionsMatrix(db, scope, cipher, homeworkId);
    expect(matrix!.students.find((s) => s.studentId === outsideUser!.id)).toBeUndefined();
    expect(matrix!.students).toHaveLength(3); // unchanged from the base fixture

    await db.delete(organizations).where(eq(organizations.id, org.id));
  });

  it("uses at most 4 db query round-trips (roster, homework+sections, conversations, submissions) -- no N+1", async () => {
    const { db, org, cipher, scope, homeworkId } = await seedMatrixFixture();

    // The roster fetch is a flat db.select(...).from(...).innerJoin(...)
    // chain, not a db.query.X.findMany call (see the bytea-corruption fix
    // above) -- found in review: the original version of this test only
    // wrapped db.query.*.findMany/findFirst methods, so after that fix the
    // roster query became invisible to this test entirely (count silently
    // dropped from 4 to 3, and a future regression to a per-student roster
    // query wouldn't be caught by the very test meant to prevent it). Wrap
    // db.select itself in addition to the three db.query.* methods -- this
    // function calls db.select() exactly once (for the roster), so counting
    // invocations of the method itself (not chained calls) correctly counts
    // it as one query alongside the other three.
    let queryCount = 0;
    const targets: Array<[object, string]> = [
      [db.query.homeworks, "findFirst"],
      [db.query.conversations, "findMany"],
      [db.query.submissions, "findMany"],
    ];
    const originals = targets.map(([obj, key]) => (obj as Record<string, unknown>)[key]);
    const originalSelect = db.select.bind(db);
    // If Drizzle's query-builder methods turn out not to be plain writable
    // own-properties (rare, but depends on the installed version), wrap
    // `db.query` itself in a Proxy counting `get` calls on `findFirst`/
    // `findMany` instead -- same intent, different mechanism.
    targets.forEach(([obj, key], i) => {
      (obj as Record<string, unknown>)[key] = (...args: unknown[]) => {
        queryCount++;
        return (originals[i] as (...a: unknown[]) => unknown).apply(obj, args);
      };
    });
    (db as unknown as Record<string, unknown>).select = (...args: unknown[]) => {
      queryCount++;
      return (originalSelect as (...a: unknown[]) => unknown)(...args);
    };
    try {
      await getHomeworkSubmissionsMatrix(db, scope, cipher, homeworkId);
    } finally {
      targets.forEach(([obj, key], i) => { (obj as Record<string, unknown>)[key] = originals[i]; });
      (db as unknown as Record<string, unknown>).select = originalSelect;
    }
    expect(queryCount).toBe(4);

    await db.delete(organizations).where(eq(organizations.id, org.id));
  });
});
