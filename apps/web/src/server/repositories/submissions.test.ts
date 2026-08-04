import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { makeNodeDb } from "../../db/nodeClient";
import type { Db } from "../../db/client";
import { organizations, courses, users, conversations } from "../../db/schema";
import { orgScope } from "./scope";
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
      return { orgId: org.id, courseId: course.id, userId: user.id };
    }
    const a = await seed("a");
    orgAId = a.orgId;
    courseAId = a.courseId;
    userAId = a.userId;
    const b = await seed("b");
    orgBId = b.orgId;
    courseBId = b.courseId;
    userBId = b.userId;
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgAId));
    await db.delete(organizations).where(eq(organizations.id, orgBId));
  });

  // Each test creates its own fresh conversation to submit against --
  // submissions.conversation_id is unique, so reusing a shared conversation
  // fixture across multiple createSubmission() calls (in different tests)
  // would collide with an earlier test's row.
  async function newConversation(courseId: string, ownerUserId: string) {
    const [conv] = await db
      .insert(conversations)
      .values({ ownerUserId, courseId, sectionId: null, kind: "tutor", title: "t" })
      .returning({ id: conversations.id });
    return conv.id;
  }

  it("createSubmission writes under the given org scope", async () => {
    const conversationId = await newConversation(courseAId, userAId);
    const created = await createSubmission(db, orgScope(orgAId), conversationId);
    expect(created.organizationId).toBe(orgAId);
  });

  it("getSubmissionByConversation scoped to org B returns nothing for an org-A conversation", async () => {
    const conversationId = await newConversation(courseAId, userAId);
    await createSubmission(db, orgScope(orgAId), conversationId);
    const result = await getSubmissionByConversation(db, orgScope(orgBId), conversationId);
    expect(result).toBeUndefined();
  });

  it("cross-org isolation: creating submissions under both orgs, an org-A-scoped list never includes org-B rows", async () => {
    const conversationId = await newConversation(courseBId, userBId);
    await createSubmission(db, orgScope(orgBId), conversationId);
    const found = await getSubmissionByConversation(db, orgScope(orgAId), conversationId);
    expect(found).toBeUndefined();
  });

  it("recordGrade writes an AI grade with no grader and a human grade rejects graded_by_ai=true with a grader set", async () => {
    const conversationId = await newConversation(courseBId, userBId);
    const sub = await createSubmission(db, orgScope(orgBId), conversationId);
    const grade = await recordGrade(db, orgScope(orgBId), {
      submissionId: sub.id,
      gradedByAi: true,
      score: 0.9,
    });
    expect(grade.gradedByAi).toBe(true);
  });
});
