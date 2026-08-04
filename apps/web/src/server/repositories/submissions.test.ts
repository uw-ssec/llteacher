import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { makeNodeDb } from "../../db/nodeClient";
import type { Db } from "../../db/client";
import { organizations, courses, users, conversations, courseMemberships, grades, homeworks, sections } from "../../db/schema";
import { unsafeOrgScope, unsafeCourseScope } from "./scope";
import { createConversation, softDeleteConversation } from "./conversations";
import { createSubmission, getSubmissionByConversation, recordGrade } from "./submissions";

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
    // grades.submission_id is ON DELETE RESTRICT (#133) -- clear grades
    // first so the org cascade has nothing left to block it.
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
});
