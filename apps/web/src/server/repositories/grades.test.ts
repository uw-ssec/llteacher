/* --------------------------------------------------------------------------
   #75: grading, against a real Postgres.

   Real-DB because the feature's central rule is expressed in the DATA rather
   than in code a mock could stand in for: a grade is in force only if
   graded_by_ai = false, history is preserved because nothing is updated in
   place, and the schema's own CHECKs reject a score with no scale and a
   grade that supersedes itself. A mocked db evaluates none of that.
   -------------------------------------------------------------------------- */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { makeNodeDb } from "../../db/nodeClient";
import type { Db } from "../../db/client";
import {
  conversations,
  courseMemberships,
  courses,
  grades,
  homeworks,
  organizations,
  sections,
  submissions,
  users,
} from "../../db/schema";
import { unsafeCourseScope, unsafeOrgScope } from "./scope";
import {
  SubmissionNotInCourseError,
  graderMembershipFor,
  listGradesForSubmission,
  recordAiDraft,
  recordHumanGrade,
} from "./grades";
import { loadIdentityCipherKeys } from "../../lib/secrets-loader";
import { IdentityCipher } from "../../lib/crypto/identity-cipher";

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)("grades repository (#75)", () => {
  let db: Db;
  let cipher: IdentityCipher;
  let orgId: string;
  let courseId: string;
  let otherCourseId: string;
  let submissionId: string;
  let instructorMembershipId: string;
  let instructorUserId: string;
  let studentMembershipId: string;

  const scope = () => unsafeCourseScope(courseId);
  const org = () => unsafeOrgScope(orgId);

  async function makeUser(name: string): Promise<string> {
    const [u] = await db
      .insert(users)
      .values({
        email: await cipher.encryptString(`${crypto.randomUUID().slice(0, 8)}@uw.edu`),
        emailBlindIndex: await cipher.computeBlindIndex(crypto.randomUUID()),
        displayName: await cipher.encryptString(name),
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
    const [o] = await db
      .insert(organizations)
      .values({
        slug: `g-${crypto.randomUUID()}`,
        name: "Grades org",
        workosOrganizationId: `w-${crypto.randomUUID()}`,
      })
      .returning({ id: organizations.id });
    orgId = o!.id;
    const [c] = await db
      .insert(courses)
      .values({ organizationId: orgId, code: "G1", term: "T", title: "Grading" })
      .returning({ id: courses.id });
    courseId = c!.id;
    const [c2] = await db
      .insert(courses)
      .values({ organizationId: orgId, code: "G2", term: "T", title: "Other" })
      .returning({ id: courses.id });
    otherCourseId = c2!.id;

    instructorUserId = await makeUser("Anjali Chen");
    const [im] = await db
      .insert(courseMemberships)
      .values({ userId: instructorUserId, courseId, role: "instructor" })
      .returning({ id: courseMemberships.id });
    instructorMembershipId = im!.id;

    const studentUserId = await makeUser("Ada Lovelace");
    const [sm] = await db
      .insert(courseMemberships)
      .values({ userId: studentUserId, courseId, role: "student" })
      .returning({ id: courseMemberships.id });
    studentMembershipId = sm!.id;

    const [hw] = await db
      .insert(homeworks)
      .values({
        courseId,
        createdById: instructorMembershipId,
        title: "HW1",
        description: "d",
        dueDate: new Date(Date.now() + 86_400_000),
      })
      .returning({ id: homeworks.id });
    const [section] = await db
      .insert(sections)
      .values({ homeworkId: hw!.id, title: "S1", content: "Explain p-values.", order: 1 })
      .returning({ id: sections.id });
    const [conv] = await db
      .insert(conversations)
      .values({
        courseId,
        ownerUserId: studentUserId,
        sectionId: section!.id,
        kind: "section",
        title: "S1 conversation",
      })
      .returning({ id: conversations.id });
    const [sub] = await db
      .insert(submissions)
      // userId/sectionId are denormalized from the conversation (#128) and
      // kept honest by submissions_conversation_owner_section_fk, so they
      // have to match the conversation's own values rather than being
      // convenient placeholders.
      .values({
        conversationId: conv!.id,
        organizationId: orgId,
        userId: studentUserId,
        sectionId: section!.id,
      })
      .returning({ id: submissions.id });
    submissionId = sub!.id;
  });

  afterAll(async () => {
    await db.delete(grades).where(eq(grades.organizationId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  async function clearGrades() {
    await db.delete(grades).where(eq(grades.submissionId, submissionId));
  }

  it("an AI draft is never the grade in force", async () => {
    await clearGrades();
    await recordAiDraft(db, scope(), org(), {
      submissionId,
      score: 80,
      maxScore: 100,
      rationale: "Reasoned well.",
      modelName: "test/model",
    });
    const listed = await listGradesForSubmission(db, scope(), submissionId, cipher);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.graderType).toBe("ai");
    // The whole design: there is no approval flag to forget, because a draft
    // simply cannot be in force.
    expect(listed[0]!.isCurrent).toBe(false);
  });

  it("a human grade is in force, and supersedes without destroying history", async () => {
    await clearGrades();
    await recordHumanGrade(db, scope(), org(), {
      submissionId,
      graderMembershipId: instructorMembershipId,
      score: 70,
      maxScore: 100,
      feedback: "First pass.",
    });
    await recordHumanGrade(db, scope(), org(), {
      submissionId,
      graderMembershipId: instructorMembershipId,
      score: 85,
      maxScore: 100,
      feedback: "Regraded after review.",
    });

    const listed = await listGradesForSubmission(db, scope(), submissionId, cipher);
    // Both rows survive: a regrade is a dispute-relevant fact, and the
    // instructor needs to see what it changed from.
    expect(listed).toHaveLength(2);
    expect(listed[0]!.score).toBe(85);
    expect(listed[0]!.isCurrent).toBe(true);
    expect(listed[1]!.score).toBe(70);
    expect(listed[1]!.isCurrent).toBe(false);
  });

  it("marks exactly one grade current even with a newer AI draft present", async () => {
    await clearGrades();
    await recordHumanGrade(db, scope(), org(), {
      submissionId,
      graderMembershipId: instructorMembershipId,
      score: 60,
      maxScore: 100,
      feedback: "Human.",
    });
    await recordAiDraft(db, scope(), org(), {
      submissionId,
      score: 95,
      maxScore: 100,
      rationale: "AI says higher.",
      modelName: "test/model",
    });
    const listed = await listGradesForSubmission(db, scope(), submissionId, cipher);
    const current = listed.filter((g) => g.isCurrent);
    // A draft written after a human grade must not displace it.
    expect(current).toHaveLength(1);
    expect(current[0]!.score).toBe(60);
  });

  it("records the draft a human grade was approved from", async () => {
    await clearGrades();
    const draftId = await recordAiDraft(db, scope(), org(), {
      submissionId,
      score: 80,
      maxScore: 100,
      rationale: "Draft.",
      modelName: "test/model",
    });
    await recordHumanGrade(db, scope(), org(), {
      submissionId,
      graderMembershipId: instructorMembershipId,
      score: 82,
      maxScore: 100,
      feedback: "Edited the draft.",
      supersedesGradeId: draftId,
    });
    const listed = await listGradesForSubmission(db, scope(), submissionId, cipher);
    // Materially different provenance from an independently-written grade,
    // for a score a student may dispute.
    expect(listed.find((g) => g.isCurrent)!.supersedesGradeId).toBe(draftId);
  });

  it("names the human grader and leaves an AI draft unattributed", async () => {
    await clearGrades();
    await recordHumanGrade(db, scope(), org(), {
      submissionId,
      graderMembershipId: instructorMembershipId,
      score: 90,
      maxScore: 100,
      feedback: "Good.",
    });
    await recordAiDraft(db, scope(), org(), {
      submissionId,
      score: 90,
      maxScore: 100,
      rationale: "Draft.",
      modelName: "test/model",
    });
    const listed = await listGradesForSubmission(db, scope(), submissionId, cipher);
    expect(listed.find((g) => g.graderType === "human")!.graderName).toBe("Anjali Chen");
    // The schema's grader-consistency CHECK makes an attributed AI grade
    // unrepresentable, so this cannot drift.
    expect(listed.find((g) => g.graderType === "ai")!.graderName).toBe("");
  });

  it("refuses a grade on a submission from another course", async () => {
    // Course-scoped, not org-scoped: an instructor of one course must not
    // grade another course's work in the same organization (#174).
    await expect(
      recordHumanGrade(db, unsafeCourseScope(otherCourseId), org(), {
        submissionId,
        graderMembershipId: instructorMembershipId,
        score: 100,
        maxScore: 100,
        feedback: "Not mine to grade.",
      }),
    ).rejects.toThrow(SubmissionNotInCourseError);
  });

  it("rejects a score with no scale at the database", async () => {
    // "7" with no denominator is unreadable a term later.
    await expect(
      db.insert(grades).values({
        organizationId: orgId,
        submissionId,
        graderMembershipId: instructorMembershipId,
        gradedByAi: false,
        score: 7,
      }),
    ).rejects.toThrow(/grades_score_requires_max_chk/);
  });

  it("accepts a feedback-only grade with no number", async () => {
    await clearGrades();
    await recordHumanGrade(db, scope(), org(), {
      submissionId,
      graderMembershipId: instructorMembershipId,
      score: null,
      maxScore: null,
      feedback: "Written comments, no mark.",
    });
    const listed = await listGradesForSubmission(db, scope(), submissionId, cipher);
    expect(listed[0]!.score).toBeNull();
    expect(listed[0]!.isCurrent).toBe(true);
  });

  it("only lets instructors be cited as the grader", async () => {
    // A TA may READ student work (#172) but a grade is attributed to someone
    // with authority over the course.
    expect(await graderMembershipFor(db, scope(), instructorUserId)).toBe(instructorMembershipId);
    const [studentRow] = await db
      .select({ userId: courseMemberships.userId })
      .from(courseMemberships)
      .where(eq(courseMemberships.id, studentMembershipId));
    expect(await graderMembershipFor(db, scope(), studentRow!.userId)).toBeNull();
  });

  it("returns nothing for a caller with no membership on the course", async () => {
    expect(await graderMembershipFor(db, scope(), await makeUser("Stranger"))).toBeNull();
  });
});
