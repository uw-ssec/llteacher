import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { makeNodeDb } from "../../db/nodeClient";
import type { Db } from "../../db/client";
import { organizations, courses, users, courseMemberships, homeworks, sections } from "../../db/schema";
import { unsafeCourseScope } from "./scope";
import { TenancyMismatchError } from "./errors";
import {
  listConversationsForOwner,
  createConversation,
  softDeleteConversation,
  appendMessage,
  getConversationById,
  getLastMessages,
  getMessagesForConversation,
  updateConversationTitle,
} from "./conversations";

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)("conversations repository", () => {
  let db: Db;
  let orgAId: string;
  let orgBId: string;
  let courseAId: string;
  let courseBId: string;
  let userId: string;
  let otherUserId: string;
  let droppedUserId: string;
  let sectionBId: string;

  beforeAll(async () => {
    db = makeNodeDb(DATABASE_URL!);
    async function makeCourse(label: string) {
      const [org] = await db
        .insert(organizations)
        .values({ slug: `conv-repo-${label}-${crypto.randomUUID()}`, name: label, workosOrganizationId: `w-${label}-${crypto.randomUUID()}` })
        .returning({ id: organizations.id });
      const [course] = await db
        .insert(courses)
        .values({ organizationId: org.id, code: "C", term: "T", title: "T" })
        .returning({ id: courses.id });
      return { orgId: org.id, courseId: course.id };
    }
    const a = await makeCourse("a");
    orgAId = a.orgId;
    courseAId = a.courseId;
    const b = await makeCourse("b");
    orgBId = b.orgId;
    courseBId = b.courseId;

    const emailBytes = crypto.getRandomValues(new Uint8Array(32));
    const [user] = await db
      .insert(users)
      .values({ email: emailBytes as never, emailBlindIndex: emailBytes as never })
      .returning({ id: users.id });
    userId = user.id;
    await db.insert(courseMemberships).values({ userId, courseId: courseAId, role: "student" });
    await db.insert(courseMemberships).values({ userId, courseId: courseBId, role: "student" });

    // A second user who is only ever a member of course B -- used to prove
    // createConversation rejects an ownerUserId with no membership in the
    // scoped course.
    const otherEmailBytes = crypto.getRandomValues(new Uint8Array(32));
    const [otherUser] = await db
      .insert(users)
      .values({ email: otherEmailBytes as never, emailBlindIndex: otherEmailBytes as never })
      .returning({ id: users.id });
    otherUserId = otherUser.id;
    await db.insert(courseMemberships).values({ userId: otherUserId, courseId: courseBId, role: "student" });

    // A third user with a *dropped* membership in course A -- used to prove
    // createConversation rejects a dropped owner even though a membership
    // row technically still exists (#139).
    const droppedEmailBytes = crypto.getRandomValues(new Uint8Array(32));
    const [droppedUser] = await db
      .insert(users)
      .values({ email: droppedEmailBytes as never, emailBlindIndex: droppedEmailBytes as never })
      .returning({ id: users.id });
    droppedUserId = droppedUser.id;
    await db.insert(courseMemberships).values({
      userId: droppedUserId,
      courseId: courseAId,
      role: "student",
      droppedAt: new Date(),
    });

    const [membershipB] = await db
      .select({ id: courseMemberships.id })
      .from(courseMemberships)
      .where(and(eq(courseMemberships.userId, userId), eq(courseMemberships.courseId, courseBId)));
    const [hwB] = await db
      .insert(homeworks)
      .values({ courseId: courseBId, createdById: membershipB.id, title: "h", description: "d", dueDate: new Date() })
      .returning({ id: homeworks.id });
    const [sectionB] = await db
      .insert(sections)
      .values({ homeworkId: hwB.id, order: 1, title: "s", content: "c" })
      .returning({ id: sections.id });
    sectionBId = sectionB.id;
  });

  it("createConversation + listConversationsForOwner round-trips a tutor conversation", async () => {
    await createConversation(db, unsafeCourseScope(courseAId), {
      ownerUserId: userId,
      sectionId: null,
      kind: "tutor",
      title: "My tutor chat",
    });
    const rows = await listConversationsForOwner(db, unsafeCourseScope(courseAId), userId);
    expect(rows.map((r) => r.title)).toContain("My tutor chat");
  });

  it("a course-A scope never returns a conversation created under course B", async () => {
    await createConversation(db, unsafeCourseScope(courseBId), {
      ownerUserId: userId,
      sectionId: null,
      kind: "tutor",
      title: "Course B chat",
    });
    const rows = await listConversationsForOwner(db, unsafeCourseScope(courseAId), userId);
    expect(rows.map((r) => r.title)).not.toContain("Course B chat");
  });

  it("excludes soft-deleted conversations by default, includes them with includeDeleted", async () => {
    const created = await createConversation(db, unsafeCourseScope(courseAId), {
      ownerUserId: userId,
      sectionId: null,
      kind: "tutor",
      title: "To be deleted",
    });
    await softDeleteConversation(db, unsafeCourseScope(courseAId), created.id);

    const defaultRows = await listConversationsForOwner(db, unsafeCourseScope(courseAId), userId);
    expect(defaultRows.map((r) => r.id)).not.toContain(created.id);

    const withDeleted = await listConversationsForOwner(db, unsafeCourseScope(courseAId), userId, {
      includeDeleted: true,
    });
    expect(withDeleted.map((r) => r.id)).toContain(created.id);
  });

  it("appendMessage adds a message to a conversation within the given scope", async () => {
    const created = await createConversation(db, unsafeCourseScope(courseAId), {
      ownerUserId: userId,
      sectionId: null,
      kind: "tutor",
      title: "Chat with messages",
    });
    const msg = await appendMessage(db, unsafeCourseScope(courseAId), created.id, {
      role: "user",
      parts: [{ type: "text", text: "hello" }],
    });
    expect(msg.conversationId).toBe(created.id);
  });

  it("appendMessage rejects a conversation scoped to a different course", async () => {
    const created = await createConversation(db, unsafeCourseScope(courseAId), {
      ownerUserId: userId,
      sectionId: null,
      kind: "tutor",
      title: "Wrong-scope append target",
    });
    await expect(
      appendMessage(db, unsafeCourseScope(courseBId), created.id, {
        role: "user",
        parts: [{ type: "text", text: "hello" }],
      }),
    ).rejects.toThrow(TenancyMismatchError);
  });

  it("appendMessage rejects a soft-deleted conversation", async () => {
    const created = await createConversation(db, unsafeCourseScope(courseAId), {
      ownerUserId: userId,
      sectionId: null,
      kind: "tutor",
      title: "Soft-deleted append target",
    });
    await softDeleteConversation(db, unsafeCourseScope(courseAId), created.id);

    await expect(
      appendMessage(db, unsafeCourseScope(courseAId), created.id, {
        role: "user",
        parts: [{ type: "text", text: "hello" }],
      }),
    ).rejects.toThrow(TenancyMismatchError);
  });

  it("rejects an ownerUserId that is not a member of the scoped course", async () => {
    await expect(
      createConversation(db, unsafeCourseScope(courseAId), {
        ownerUserId: otherUserId,
        sectionId: null,
        kind: "tutor",
        title: "Should not be created",
      }),
    ).rejects.toThrow(TenancyMismatchError);
  });

  it("rejects a dropped owner even though a membership row exists (#139)", async () => {
    await expect(
      createConversation(db, unsafeCourseScope(courseAId), {
        ownerUserId: droppedUserId,
        sectionId: null,
        kind: "tutor",
        title: "Should not be created",
      }),
    ).rejects.toThrow(TenancyMismatchError);
  });

  it("getConversationById returns the row regardless of scope (unscoped by design -- callers verify ownership themselves)", async () => {
    const created = await createConversation(db, unsafeCourseScope(courseAId), {
      ownerUserId: userId,
      sectionId: null,
      kind: "tutor",
      title: "Findable by id",
    });
    const found = await getConversationById(db, created.id);
    expect(found?.id).toBe(created.id);
    expect(found?.ownerUserId).toBe(userId);
  });

  it("getConversationById returns null for a nonexistent id", async () => {
    const found = await getConversationById(db, "00000000-0000-0000-0000-000000000000");
    expect(found).toBeNull();
  });

  it("getLastMessages returns the most recent messages newest-first, capped at limit", async () => {
    const created = await createConversation(db, unsafeCourseScope(courseAId), {
      ownerUserId: userId,
      sectionId: null,
      kind: "tutor",
      title: "Last messages target",
    });
    await appendMessage(db, unsafeCourseScope(courseAId), created.id, {
      role: "user",
      parts: [{ type: "text", text: "first" }],
    });
    await appendMessage(db, unsafeCourseScope(courseAId), created.id, {
      role: "assistant",
      parts: [{ type: "text", text: "second" }],
    });
    const last = await getLastMessages(db, unsafeCourseScope(courseAId), created.id, 2);
    expect(last).toHaveLength(2);
    expect(last[0]?.role).toBe("assistant");
    expect(last[0]?.parts).toEqual([{ type: "text", text: "second" }]);
    expect(last[1]?.role).toBe("user");
    expect(last[1]?.parts).toEqual([{ type: "text", text: "first" }]);
  });

  it("getLastMessages returns an empty array for a conversation scoped to a different course", async () => {
    const created = await createConversation(db, unsafeCourseScope(courseAId), {
      ownerUserId: userId,
      sectionId: null,
      kind: "tutor",
      title: "Wrong-scope last-messages target",
    });
    await appendMessage(db, unsafeCourseScope(courseAId), created.id, {
      role: "user",
      parts: [{ type: "text", text: "hello" }],
    });
    const last = await getLastMessages(db, unsafeCourseScope(courseBId), created.id, 2);
    expect(last).toEqual([]);
  });

  it("getMessagesForConversation (#4 fix-round) returns full history oldest-first", async () => {
    const created = await createConversation(db, unsafeCourseScope(courseAId), {
      ownerUserId: userId,
      sectionId: null,
      kind: "tutor",
      title: "Full history target",
    });
    await appendMessage(db, unsafeCourseScope(courseAId), created.id, {
      role: "user",
      parts: [{ type: "text", text: "first" }],
    });
    await appendMessage(db, unsafeCourseScope(courseAId), created.id, {
      role: "assistant",
      parts: [{ type: "text", text: "second" }],
    });
    await appendMessage(db, unsafeCourseScope(courseAId), created.id, {
      role: "user",
      parts: [{ type: "text", text: "third" }],
    });

    const history = await getMessagesForConversation(db, unsafeCourseScope(courseAId), created.id);

    // Oldest-first -- the opposite of getLastMessages' newest-first order
    // above, since this is seeding a client's initial message list in
    // conversation order, not detecting the most recent turn for a retry.
    expect(history).toHaveLength(3);
    expect(history[0]?.role).toBe("user");
    expect(history[0]?.parts).toEqual([{ type: "text", text: "first" }]);
    expect(history[1]?.role).toBe("assistant");
    expect(history[1]?.parts).toEqual([{ type: "text", text: "second" }]);
    expect(history[2]?.role).toBe("user");
    expect(history[2]?.parts).toEqual([{ type: "text", text: "third" }]);
  });

  it("getMessagesForConversation returns an empty array for a conversation scoped to a different course", async () => {
    const created = await createConversation(db, unsafeCourseScope(courseAId), {
      ownerUserId: userId,
      sectionId: null,
      kind: "tutor",
      title: "Wrong-scope full-history target",
    });
    await appendMessage(db, unsafeCourseScope(courseAId), created.id, {
      role: "user",
      parts: [{ type: "text", text: "hello" }],
    });
    const history = await getMessagesForConversation(db, unsafeCourseScope(courseBId), created.id);
    expect(history).toEqual([]);
  });

  it("listConversationsForOwner's kind filter (#5) narrows to just that kind", async () => {
    await createConversation(db, unsafeCourseScope(courseBId), {
      ownerUserId: userId,
      sectionId: null,
      kind: "tutor",
      title: "Kind filter: tutor chat",
    });
    await createConversation(db, unsafeCourseScope(courseBId), {
      ownerUserId: userId,
      sectionId: sectionBId,
      kind: "section",
      title: "Kind filter: section chat",
    });

    const tutorOnly = await listConversationsForOwner(db, unsafeCourseScope(courseBId), userId, { kind: "tutor" });
    expect(tutorOnly.map((r) => r.title)).toContain("Kind filter: tutor chat");
    expect(tutorOnly.map((r) => r.title)).not.toContain("Kind filter: section chat");

    const sectionOnly = await listConversationsForOwner(db, unsafeCourseScope(courseBId), userId, {
      kind: "section",
    });
    expect(sectionOnly.map((r) => r.title)).toContain("Kind filter: section chat");
    expect(sectionOnly.map((r) => r.title)).not.toContain("Kind filter: tutor chat");

    // No kind filter (omitted opts.kind) -- unchanged pre-#5 behavior, both
    // kinds still come back.
    const both = await listConversationsForOwner(db, unsafeCourseScope(courseBId), userId);
    expect(both.map((r) => r.title)).toEqual(
      expect.arrayContaining(["Kind filter: tutor chat", "Kind filter: section chat"]),
    );
  });

  it("listConversationsForOwner orders by updatedAt desc (#5)", async () => {
    const older = await createConversation(db, unsafeCourseScope(courseAId), {
      ownerUserId: userId,
      sectionId: null,
      kind: "tutor",
      title: "Ordering: created first",
    });
    const newer = await createConversation(db, unsafeCourseScope(courseAId), {
      ownerUserId: userId,
      sectionId: null,
      kind: "tutor",
      title: "Ordering: created second",
    });
    // Bump `older`'s updatedAt past `newer`'s so creation order and
    // updatedAt order genuinely disagree -- proves the list is ordered by
    // updatedAt, not insertion/created_at order.
    await updateConversationTitle(db, unsafeCourseScope(courseAId), older.id, "Ordering: now most recently updated");

    const rows = await listConversationsForOwner(db, unsafeCourseScope(courseAId), userId);
    const olderIdx = rows.findIndex((r) => r.id === older.id);
    const newerIdx = rows.findIndex((r) => r.id === newer.id);
    expect(olderIdx).toBeGreaterThanOrEqual(0);
    expect(newerIdx).toBeGreaterThanOrEqual(0);
    expect(olderIdx).toBeLessThan(newerIdx);
  });

  it("listConversationsForOwner reports messageCount per conversation (#4)", async () => {
    const withMessages = await createConversation(db, unsafeCourseScope(courseAId), {
      ownerUserId: userId,
      sectionId: null,
      kind: "tutor",
      title: "Message count: has messages",
    });
    await appendMessage(db, unsafeCourseScope(courseAId), withMessages.id, {
      role: "user",
      parts: [{ type: "text", text: "one" }],
    });
    await appendMessage(db, unsafeCourseScope(courseAId), withMessages.id, {
      role: "assistant",
      parts: [{ type: "text", text: "two" }],
    });
    const withoutMessages = await createConversation(db, unsafeCourseScope(courseAId), {
      ownerUserId: userId,
      sectionId: null,
      kind: "tutor",
      title: "Message count: no messages",
    });

    const rows = await listConversationsForOwner(db, unsafeCourseScope(courseAId), userId);
    const withMessagesRow = rows.find((r) => r.id === withMessages.id);
    const withoutMessagesRow = rows.find((r) => r.id === withoutMessages.id);
    expect(withMessagesRow?.messageCount).toBe(2);
    expect(withoutMessagesRow?.messageCount).toBe(0);
  });

  it("updateConversationTitle updates and returns the row within scope", async () => {
    const created = await createConversation(db, unsafeCourseScope(courseAId), {
      ownerUserId: userId,
      sectionId: null,
      kind: "tutor",
      title: "Original title",
    });
    const updated = await updateConversationTitle(db, unsafeCourseScope(courseAId), created.id, "Renamed");
    expect(updated?.id).toBe(created.id);
    expect(updated?.title).toBe("Renamed");
  });

  it("updateConversationTitle returns null for a conversation scoped to a different course", async () => {
    const created = await createConversation(db, unsafeCourseScope(courseAId), {
      ownerUserId: userId,
      sectionId: null,
      kind: "tutor",
      title: "Wrong-scope update target",
    });
    const updated = await updateConversationTitle(db, unsafeCourseScope(courseBId), created.id, "Should not apply");
    expect(updated).toBeNull();
  });

  it("updateConversationTitle returns null for a soft-deleted conversation", async () => {
    const created = await createConversation(db, unsafeCourseScope(courseAId), {
      ownerUserId: userId,
      sectionId: null,
      kind: "tutor",
      title: "Soft-deleted update target",
    });
    await softDeleteConversation(db, unsafeCourseScope(courseAId), created.id);
    const updated = await updateConversationTitle(db, unsafeCourseScope(courseAId), created.id, "Should not apply");
    expect(updated).toBeNull();
  });

  it("rejects a sectionId that belongs to a different course", async () => {
    await expect(
      createConversation(db, unsafeCourseScope(courseAId), {
        ownerUserId: userId,
        sectionId: sectionBId,
        kind: "section",
        title: "Should not be created",
      }),
    ).rejects.toThrow(TenancyMismatchError);
  });

  afterAll(async () => {
    // Deleting the orgs cascades courses (and everything under them); a
    // direct courses delete alone leaves the parent organizations rows
    // behind (courses don't own their org), and neither one touches
    // `users`, which never cascades from a course/org by design.
    await db.delete(organizations).where(eq(organizations.id, orgAId));
    await db.delete(organizations).where(eq(organizations.id, orgBId));
    await db.delete(users).where(eq(users.id, userId));
    await db.delete(users).where(eq(users.id, otherUserId));
    await db.delete(users).where(eq(users.id, droppedUserId));
  });
});
