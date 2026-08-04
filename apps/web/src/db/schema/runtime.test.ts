import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { makeNodeDb } from "../nodeClient";
import type { Db } from "../client";
import {
  conversations,
  messages,
  organizations,
  courses,
  users,
  sections,
  homeworks,
  courseMemberships,
  submissions,
  grades,
  citations,
  courseMaterials,
  materialChunks,
} from "../schema";

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)("conversations + messages schema", () => {
  let db: Db;
  let orgId: string;
  let courseId: string;
  let userId: string;
  let sectionId: string;
  let homeworkId: string;

  beforeAll(async () => {
    db = makeNodeDb(DATABASE_URL!);
    const [org] = await db
      .insert(organizations)
      .values({
        slug: `runtime-test-${crypto.randomUUID()}`,
        name: "Runtime Test Org",
        workosOrganizationId: `workos-${crypto.randomUUID()}`,
      })
      .returning({ id: organizations.id });
    orgId = org.id;

    const [course] = await db
      .insert(courses)
      .values({ organizationId: orgId, code: "TEST 101", term: "T1", title: "Test" })
      .returning({ id: courses.id });
    courseId = course.id;

    const emailBytes = crypto.getRandomValues(new Uint8Array(32));
    const [user] = await db
      .insert(users)
      .values({ email: emailBytes as never, emailBlindIndex: emailBytes as never })
      .returning({ id: users.id });
    userId = user.id;

    const [membership] = await db
      .insert(courseMemberships)
      .values({ userId, courseId, role: "instructor" })
      .returning({ id: courseMemberships.id });

    const [hw] = await db
      .insert(homeworks)
      .values({
        courseId,
        createdById: membership.id,
        title: "HW",
        description: "d",
        dueDate: new Date(),
      })
      .returning({ id: homeworks.id });
    homeworkId = hw.id;

    const [section] = await db
      .insert(sections)
      .values({ homeworkId: hw.id, order: 1, title: "S1", content: "c" })
      .returning({ id: sections.id });
    sectionId = section.id;
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  it("rejects a tutor conversation with a non-null sectionId", async () => {
    await expect(
      db.insert(conversations).values({
        ownerUserId: userId,
        courseId,
        sectionId,
        kind: "tutor",
        title: "t",
      }),
    ).rejects.toThrow();
  });

  it("rejects a section conversation with a null sectionId", async () => {
    await expect(
      db.insert(conversations).values({
        ownerUserId: userId,
        courseId,
        sectionId: null,
        kind: "section",
        title: "t",
      }),
    ).rejects.toThrow();
  });

  it("rejects a second active section-conversation for the same (user, section)", async () => {
    await db.insert(conversations).values({
      ownerUserId: userId,
      courseId,
      sectionId,
      kind: "section",
      title: "first",
    });
    await expect(
      db.insert(conversations).values({
        ownerUserId: userId,
        courseId,
        sectionId,
        kind: "section",
        title: "second",
      }),
    ).rejects.toThrow();
  });

  it("allows a new active conversation once the prior one is soft-deleted", async () => {
    // Own section, distinct from the shared `sectionId` fixture -- an
    // earlier test already leaves an active conversation on that one, and
    // conversations_owner_section_active_uq would collide with it here.
    const [section] = await db
      .insert(sections)
      .values({ homeworkId, order: 2, title: "S2", content: "c" })
      .returning({ id: sections.id });

    const [first] = await db
      .insert(conversations)
      .values({ ownerUserId: userId, courseId, sectionId: section.id, kind: "section", title: "a" })
      .returning({ id: conversations.id });
    await db
      .update(conversations)
      .set({ isDeleted: true, deletedAt: new Date() })
      .where(eq(conversations.id, first.id));

    await expect(
      db.insert(conversations).values({
        ownerUserId: userId,
        courseId,
        sectionId: section.id,
        kind: "section",
        title: "b",
      }),
    ).resolves.toBeDefined();
  });

  it("round-trips jsonb parts (including tool-call shape) unchanged", async () => {
    const [conv] = await db
      .insert(conversations)
      .values({ ownerUserId: userId, courseId, sectionId: null, kind: "tutor", title: "t" })
      .returning({ id: conversations.id });

    const parts = [
      { type: "text", text: "hi" },
      { type: "tool-call", toolCallId: "abc", toolName: "run_code", args: { code: "1+1" } },
    ];
    const [msg] = await db
      .insert(messages)
      .values({ conversationId: conv.id, role: "assistant", parts })
      .returning({ parts: messages.parts });

    expect(msg.parts).toEqual(parts);
  });

  it("rejects a message referencing a non-existent conversationId", async () => {
    await expect(
      db.insert(messages).values({
        conversationId: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: "x" }],
      }),
    ).rejects.toThrow();
  });

  it("cascade-deletes messages when their conversation is deleted", async () => {
    const [conv] = await db
      .insert(conversations)
      .values({ ownerUserId: userId, courseId, sectionId: null, kind: "tutor", title: "t2" })
      .returning({ id: conversations.id });
    await db
      .insert(messages)
      .values({ conversationId: conv.id, role: "user", parts: [{ type: "text", text: "hi" }] });

    await db.delete(conversations).where(eq(conversations.id, conv.id));

    const remaining = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conv.id));
    expect(remaining).toHaveLength(0);
  });
});

describe.skipIf(!DATABASE_URL)("submissions, grades, citations schema", () => {
  let db: Db;
  let orgAId: string;
  let orgBId: string;
  let courseAId: string;
  let userAId: string;
  let conversationAId: string;

  beforeAll(async () => {
    db = makeNodeDb(DATABASE_URL!);

    async function makeOrgWithConversation(label: string) {
      const [org] = await db
        .insert(organizations)
        .values({
          slug: `sub-test-${label}-${crypto.randomUUID()}`,
          name: `Sub Test Org ${label}`,
          workosOrganizationId: `workos-${label}-${crypto.randomUUID()}`,
        })
        .returning({ id: organizations.id });
      const [course] = await db
        .insert(courses)
        .values({ organizationId: org.id, code: "T1", term: "T1", title: "T" })
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
      const [hw] = await db
        .insert(homeworks)
        .values({ courseId: course.id, createdById: membership.id, title: "h", description: "d", dueDate: new Date() })
        .returning({ id: homeworks.id });
      const [section] = await db
        .insert(sections)
        .values({ homeworkId: hw.id, order: 1, title: "s", content: "c" })
        .returning({ id: sections.id });
      const [conv] = await db
        .insert(conversations)
        .values({ ownerUserId: user.id, courseId: course.id, sectionId: section.id, kind: "section", title: "t" })
        .returning({ id: conversations.id });
      return { orgId: org.id, courseId: course.id, userId: user.id, sectionId: section.id, conversationId: conv.id };
    }

    const a = await makeOrgWithConversation("a");
    orgAId = a.orgId;
    courseAId = a.courseId;
    userAId = a.userId;
    conversationAId = a.conversationId;

    const b = await makeOrgWithConversation("b");
    orgBId = b.orgId;
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgAId));
    await db.delete(organizations).where(eq(organizations.id, orgBId));
  });

  it("rejects a second submission for the same conversation", async () => {
    await db.insert(submissions).values({ conversationId: conversationAId, organizationId: orgAId });
    await expect(
      db.insert(submissions).values({ conversationId: conversationAId, organizationId: orgAId }),
    ).rejects.toThrow();
  });

  it("a query scoped to org A returns zero submissions seeded under org B", async () => {
    const rows = await db.select().from(submissions).where(eq(submissions.organizationId, orgBId));
    expect(rows).toHaveLength(0);
  });

  it("rejects a grade that is both graded_by_ai and has a grader_membership_id", async () => {
    const [sub] = await db
      .select({ id: submissions.id })
      .from(submissions)
      .where(eq(submissions.conversationId, conversationAId));
    const [membership] = await db
      .select({ id: courseMemberships.id })
      .from(courseMemberships)
      .where(eq(courseMemberships.courseId, courseAId));

    await expect(
      db.insert(grades).values({
        submissionId: sub.id,
        organizationId: orgAId,
        gradedByAi: true,
        graderMembershipId: membership.id,
      }),
    ).rejects.toThrow();
  });

  it("rejects a grade with neither graded_by_ai nor a grader", async () => {
    const [sub] = await db
      .select({ id: submissions.id })
      .from(submissions)
      .where(eq(submissions.conversationId, conversationAId));
    await expect(
      db.insert(grades).values({ submissionId: sub.id, organizationId: orgAId, gradedByAi: false }),
    ).rejects.toThrow();
  });

  it("rejects a citation with both messageId and gradeId set, and one with neither", async () => {
    const [msg] = await db
      .insert(messages)
      .values({ conversationId: conversationAId, role: "user", parts: [{ type: "text", text: "x" }] })
      .returning({ id: messages.id });
    const [membership] = await db
      .select({ id: courseMemberships.id })
      .from(courseMemberships)
      .where(eq(courseMemberships.courseId, courseAId));
    const [material] = await db
      .insert(courseMaterials)
      .values({
        courseId: courseAId,
        uploadedById: membership.id,
        sourceType: "pdf",
        title: "m",
      })
      .returning({ id: courseMaterials.id });
    const [chunk] = await db
      .insert(materialChunks)
      .values({ materialId: material.id, ordinal: 0, text: "t", tokenCount: 1 })
      .returning({ id: materialChunks.id });

    await expect(
      db.insert(citations).values({
        messageId: msg.id,
        gradeId: crypto.randomUUID(),
        materialChunkId: chunk.id,
        organizationId: orgAId,
      }),
    ).rejects.toThrow();

    await expect(
      db.insert(citations).values({
        materialChunkId: chunk.id,
        organizationId: orgAId,
      }),
    ).rejects.toThrow();
  });

  it("cascade-deletes submission (and its grades) when the conversation is deleted", async () => {
    const [conv] = await db
      .insert(conversations)
      .values({ ownerUserId: userAId, courseId: courseAId, sectionId: null, kind: "tutor", title: "cascade-test" })
      .returning({ id: conversations.id });
    const [sub] = await db
      .insert(submissions)
      .values({ conversationId: conv.id, organizationId: orgAId })
      .returning({ id: submissions.id });
    await db.insert(grades).values({ submissionId: sub.id, organizationId: orgAId, gradedByAi: true });

    await db.delete(conversations).where(eq(conversations.id, conv.id));

    const remainingSubs = await db.select().from(submissions).where(eq(submissions.id, sub.id));
    const remainingGrades = await db.select().from(grades).where(eq(grades.submissionId, sub.id));
    expect(remainingSubs).toHaveLength(0);
    expect(remainingGrades).toHaveLength(0);
  });
});
