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
