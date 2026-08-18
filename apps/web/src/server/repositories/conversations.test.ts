import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { makeNodeDb } from "../../db/nodeClient";
import type { Db } from "../../db/client";
import { organizations, courses, users, courseMemberships, homeworks, sections, conversations } from "../../db/schema";
import { unsafeCourseScope } from "./scope";
import { TenancyMismatchError, IdempotencyKeyConflictError } from "./errors";
import {
  listConversationsForOwner,
  createConversation,
  countActiveConversationsForOwner,
  softDeleteConversation,
  appendMessage,
  getConversationById,
  getOwnedConversationOrNull,
  getLastMessages,
  getMessagesForConversation,
  updateConversationTitle,
  acquireConversationTurnLock,
  releaseConversationTurnLock,
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

  // #308: backs createConversationHandler's per-user conversation cap.
  // Delta-based (not an absolute-count assertion) since this file's other
  // tests share the same (userId, courseAId) pair and run in the same DB.
  it("countActiveConversationsForOwner counts only live tutor conversations for (owner, scope, kind)", async () => {
    const before = await countActiveConversationsForOwner(db, unsafeCourseScope(courseAId), userId, "tutor");

    const created = await createConversation(db, unsafeCourseScope(courseAId), {
      ownerUserId: userId,
      sectionId: null,
      kind: "tutor",
      title: "#308 cap counting fixture",
    });
    expect(await countActiveConversationsForOwner(db, unsafeCourseScope(courseAId), userId, "tutor")).toBe(
      before + 1,
    );

    // Soft-deleting drops it back out of the live count -- the intended
    // relief valve (a student who deletes old conversations gets room back).
    await softDeleteConversation(db, unsafeCourseScope(courseAId), created.id);
    expect(await countActiveConversationsForOwner(db, unsafeCourseScope(courseAId), userId, "tutor")).toBe(before);
  });

  it("countActiveConversationsForOwner does not count a different course's conversations", async () => {
    const beforeA = await countActiveConversationsForOwner(db, unsafeCourseScope(courseAId), userId, "tutor");

    await createConversation(db, unsafeCourseScope(courseBId), {
      ownerUserId: userId,
      sectionId: null,
      kind: "tutor",
      title: "#308 cross-course cap fixture",
    });

    expect(await countActiveConversationsForOwner(db, unsafeCourseScope(courseAId), userId, "tutor")).toBe(beforeA);
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
    const { row: msg, created: wasCreated } = await appendMessage(db, unsafeCourseScope(courseAId), created.id, {
      role: "user",
      parts: [{ type: "text", text: "hello" }],
    });
    expect(msg.conversationId).toBe(created.id);
    expect(wasCreated).toBe(true);
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

  // PR-1 whole-branch review (#140): appendMessage previously only wrote to
  // `messages`, never touching the parent conversation row -- so
  // listConversationsForOwner's `ORDER BY updatedAt DESC` (#5) never
  // reflected actual chat activity, only renames (the only other writer of
  // this row). Real DB test (not the mocked route-level one) specifically
  // because the fix relies on Postgres's own clock advancing between the
  // two inserts, which a mock can't meaningfully simulate.
  it("appendMessage bumps the parent conversation's updatedAt (#140)", async () => {
    const created = await createConversation(db, unsafeCourseScope(courseAId), {
      ownerUserId: userId,
      sectionId: null,
      kind: "tutor",
      title: "Chat whose updatedAt should move",
    });
    const before = await getConversationById(db, created.id);

    // Ensure a measurable clock gap regardless of how fast the two queries
    // resolve -- timestamp columns have millisecond, not nanosecond,
    // resolution.
    await new Promise((resolve) => setTimeout(resolve, 5));

    await appendMessage(db, unsafeCourseScope(courseAId), created.id, {
      role: "user",
      parts: [{ type: "text", text: "hello" }],
    });

    const after = await getConversationById(db, created.id);
    expect(after!.updatedAt.getTime()).toBeGreaterThan(before!.updatedAt.getTime());
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

  // #317 review, #326 (remaining requirement): getConversationById joins
  // courses for organizationId -- chat.ts's resolveConversation uses this to
  // resolve org scope off the same row instead of a second, separate
  // getOrgScopeForCourse round-trip for the exact same course.
  it("getConversationById joins courses and returns the owning course's organizationId", async () => {
    const created = await createConversation(db, unsafeCourseScope(courseAId), {
      ownerUserId: userId,
      sectionId: null,
      kind: "tutor",
      title: "Carries org scope",
    });
    const found = await getConversationById(db, created.id);
    expect(found?.organizationId).toBe(orgAId);
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

  // #279: skipOwnershipCheck exists so chatHandler can skip a redundant
  // round-trip once it has already proven scope membership elsewhere in the
  // same request -- it must never become an accidental way to bypass the
  // check for a caller that hasn't. These two tests pin both halves: the
  // flag genuinely skips (misuse is possible, by design, for a caller that
  // opts in) and the DEFAULT (omitted, matching every non-chat.ts caller)
  // still enforces it.
  it("getLastMessages still returns [] for a wrong-scope conversation when skipOwnershipCheck is omitted (default-safe)", async () => {
    const created = await createConversation(db, unsafeCourseScope(courseAId), {
      ownerUserId: userId,
      sectionId: null,
      kind: "tutor",
      title: "Default-safe target",
    });
    await appendMessage(db, unsafeCourseScope(courseAId), created.id, {
      role: "user",
      parts: [{ type: "text", text: "hello" }],
    });
    const last = await getLastMessages(db, unsafeCourseScope(courseBId), created.id, 2, {});
    expect(last).toEqual([]);
  });

  it("getLastMessages returns rows for a wrong-scope conversation when skipOwnershipCheck is true (opt-in bypass, not a default)", async () => {
    const created = await createConversation(db, unsafeCourseScope(courseAId), {
      ownerUserId: userId,
      sectionId: null,
      kind: "tutor",
      title: "Opt-in-bypass target",
    });
    await appendMessage(db, unsafeCourseScope(courseAId), created.id, {
      role: "user",
      parts: [{ type: "text", text: "hello" }],
    });
    // Wrong scope (courseB), but the caller asserts it already verified --
    // the row comes back anyway, proving the check genuinely didn't run.
    const last = await getLastMessages(db, unsafeCourseScope(courseBId), created.id, 2, {
      skipOwnershipCheck: true,
    });
    expect(last).toHaveLength(1);
  });

  it("appendMessage still throws TenancyMismatchError for a wrong-scope conversation when skipOwnershipCheck is omitted (default-safe)", async () => {
    const created = await createConversation(db, unsafeCourseScope(courseAId), {
      ownerUserId: userId,
      sectionId: null,
      kind: "tutor",
      title: "Default-safe append target",
    });
    await expect(
      appendMessage(db, unsafeCourseScope(courseBId), created.id, {
        role: "user",
        parts: [{ type: "text", text: "hello" }],
      }),
    ).rejects.toThrow(TenancyMismatchError);
  });

  it("appendMessage writes into a wrong-scope conversation when skipOwnershipCheck is true (opt-in bypass, not a default)", async () => {
    const created = await createConversation(db, unsafeCourseScope(courseAId), {
      ownerUserId: userId,
      sectionId: null,
      kind: "tutor",
      title: "Opt-in-bypass append target",
    });
    const { row } = await appendMessage(
      db,
      unsafeCourseScope(courseBId),
      created.id,
      { role: "user", parts: [{ type: "text", text: "hello" }] },
      { skipOwnershipCheck: true },
    );
    expect(row.conversationId).toBe(created.id);
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

  // #213: clientMessageId round-trips through appendMessage/getLastMessages,
  // and Postgres's unique index tolerates multiple NULLs (assistant rows)
  // without colliding against each other.
  describe("#213 clientMessageId", () => {
    it("persists and round-trips a user row's clientMessageId", async () => {
      const created = await createConversation(db, unsafeCourseScope(courseAId), {
        ownerUserId: userId,
        sectionId: null,
        kind: "tutor",
        title: "clientMessageId round-trip",
      });
      await appendMessage(db, unsafeCourseScope(courseAId), created.id, {
        role: "user",
        parts: [{ type: "text", text: "hi" }],
        clientMessageId: "client-abc",
      });
      const [last] = await getLastMessages(db, unsafeCourseScope(courseAId), created.id, 1);
      expect(last?.clientMessageId).toBe("client-abc");
    });

    it("allows multiple assistant rows with a null clientMessageId in the same conversation (unique index tolerates NULLs)", async () => {
      const created = await createConversation(db, unsafeCourseScope(courseAId), {
        ownerUserId: userId,
        sectionId: null,
        kind: "tutor",
        title: "Multiple null clientMessageId rows",
      });
      await appendMessage(db, unsafeCourseScope(courseAId), created.id, {
        role: "assistant",
        parts: [{ type: "text", text: "one" }],
      });
      await expect(
        appendMessage(db, unsafeCourseScope(courseAId), created.id, {
          role: "assistant",
          parts: [{ type: "text", text: "two" }],
        }),
      ).resolves.toBeDefined();
    });

    // #254: a second appendMessage call with a clientMessageId that's
    // already taken in this conversation used to reject with a raw
    // Postgres unique-violation (chat.ts's caller had nothing to catch it,
    // so it fell through to app.onError's generic 503) -- .onConflictDoNothing
    // makes this resolve with the EXISTING row instead, same as a
    // successful retry, PROVIDED the content actually matches (#266 below
    // covers the case where it doesn't).
    it("resolves with the existing row (not a throw) on a sequential duplicate clientMessageId with identical content", async () => {
      const created = await createConversation(db, unsafeCourseScope(courseAId), {
        ownerUserId: userId,
        sectionId: null,
        kind: "tutor",
        title: "Duplicate clientMessageId, same content",
      });
      const first = await appendMessage(db, unsafeCourseScope(courseAId), created.id, {
        role: "user",
        parts: [{ type: "text", text: "same text both times" }],
        clientMessageId: "dupe-id",
      });
      expect(first.created).toBe(true);

      const second = await appendMessage(db, unsafeCourseScope(courseAId), created.id, {
        role: "user",
        parts: [{ type: "text", text: "same text both times" }],
        clientMessageId: "dupe-id",
      });

      // #273: the second call must know it lost the race, not just get a
      // row back indistinguishable from a fresh insert.
      expect(second.created).toBe(false);
      expect(second.row.id).toBe(first.row.id);

      const all = await getMessagesForConversation(db, unsafeCourseScope(courseAId), created.id);
      expect(all.filter((m) => m.clientMessageId === "dupe-id")).toHaveLength(1);
    });

    // #266: this used to silently resolve with "first"'s row and drop
    // "second" entirely -- while chatHandler still called the model against
    // "second"'s text, persisting an answer with no matching question in
    // the transcript. clientMessageId is client-controlled and never bound
    // to the content it claims to identify, so a reused id with genuinely
    // different content is now a hard refusal instead of a silent drop.
    it("throws IdempotencyKeyConflictError (not a silent drop) on a sequential duplicate clientMessageId with DIFFERENT content", async () => {
      const created = await createConversation(db, unsafeCourseScope(courseAId), {
        ownerUserId: userId,
        sectionId: null,
        kind: "tutor",
        title: "Duplicate clientMessageId, different content",
      });
      await appendMessage(db, unsafeCourseScope(courseAId), created.id, {
        role: "user",
        parts: [{ type: "text", text: "first" }],
        clientMessageId: "dupe-id-mismatch",
      });

      await expect(
        appendMessage(db, unsafeCourseScope(courseAId), created.id, {
          role: "user",
          parts: [{ type: "text", text: "second, genuinely different" }],
          clientMessageId: "dupe-id-mismatch",
        }),
      ).rejects.toBeInstanceOf(IdempotencyKeyConflictError);

      // Not an orphan: exactly the first row survives, "second" never lands.
      const all = await getMessagesForConversation(db, unsafeCourseScope(courseAId), created.id);
      const matching = all.filter((m) => m.clientMessageId === "dupe-id-mismatch");
      expect(matching).toHaveLength(1);
      expect(matching[0]?.parts).toEqual([{ type: "text", text: "first" }]);
    });

    // #266's own concurrent scenario: two in-flight requests race with the
    // SAME clientMessageId but DIFFERENT content (not the #254 case of
    // identical retries). The loser must reject with the typed error, not
    // silently resolve with the winner's row -- and exactly one row (the
    // winner's) must survive either way.
    it("under a concurrent race with DIFFERENT content for the same clientMessageId, the loser rejects and exactly one row persists", async () => {
      const created = await createConversation(db, unsafeCourseScope(courseAId), {
        ownerUserId: userId,
        sectionId: null,
        kind: "tutor",
        title: "Concurrent duplicate clientMessageId, different content",
      });

      const results = await Promise.allSettled([
        appendMessage(db, unsafeCourseScope(courseAId), created.id, {
          role: "user",
          parts: [{ type: "text", text: "version A" }],
          clientMessageId: "concurrent-mismatch-id",
        }),
        appendMessage(db, unsafeCourseScope(courseAId), created.id, {
          role: "user",
          parts: [{ type: "text", text: "version B" }],
          clientMessageId: "concurrent-mismatch-id",
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(IdempotencyKeyConflictError);

      const all = await getMessagesForConversation(db, unsafeCourseScope(courseAId), created.id);
      expect(all.filter((m) => m.clientMessageId === "concurrent-mismatch-id")).toHaveLength(1);
    });

    // #254's actual scenario: two requests genuinely racing (a double-fired
    // Retry, a fetch-layer retry, a duplicated tab), not just two
    // sequential calls -- Promise.all fires both appendMessage calls before
    // either's insert has committed, exercising the real concurrent path
    // .onConflictDoNothing exists for (Postgres's unique index resolves
    // the conflict atomically; there is no serialization step to get
    // wrong). Both promises must resolve (neither may reject/500), and
    // exactly one row survives.
    it("two concurrent appendMessage calls with the same clientMessageId both resolve, exactly one row persists", async () => {
      const created = await createConversation(db, unsafeCourseScope(courseAId), {
        ownerUserId: userId,
        sectionId: null,
        kind: "tutor",
        title: "Concurrent duplicate clientMessageId",
      });

      const [a, b] = await Promise.all([
        appendMessage(db, unsafeCourseScope(courseAId), created.id, {
          role: "user",
          parts: [{ type: "text", text: "concurrent send" }],
          clientMessageId: "concurrent-id",
        }),
        appendMessage(db, unsafeCourseScope(courseAId), created.id, {
          role: "user",
          parts: [{ type: "text", text: "concurrent send" }],
          clientMessageId: "concurrent-id",
        }),
      ]);

      expect(a).toBeDefined();
      expect(b).toBeDefined();
      expect(a.row.id).toBe(b.row.id); // the "loser" got the winner's row back, not a second one
      // #273: exactly one of the two calls actually created the row -- this
      // is what lets chatHandler tell winner from loser under real
      // concurrency, not just in the sequential case above.
      expect([a.created, b.created].sort()).toEqual([false, true]);

      const all = await getMessagesForConversation(db, unsafeCourseScope(courseAId), created.id);
      expect(all.filter((m) => m.clientMessageId === "concurrent-id")).toHaveLength(1);
    });
  });

  // #221: seq is the real ordering key -- this proves it tracks insertion
  // order (createdAt alone already does in practice; seq's whole point is
  // to be correct even when two rows share a millisecond, which a
  // millisecond-resolution real-DB test can't force deterministically, but
  // the ordering it produces here must still match insertion order).
  it("#221 orders getLastMessages/getMessagesForConversation by seq, matching insertion order", async () => {
    const created = await createConversation(db, unsafeCourseScope(courseAId), {
      ownerUserId: userId,
      sectionId: null,
      kind: "tutor",
      title: "Seq ordering target",
    });
    for (const text of ["a", "b", "c", "d"]) {
      await appendMessage(db, unsafeCourseScope(courseAId), created.id, {
        role: "user",
        parts: [{ type: "text", text }],
      });
    }
    const forward = await getMessagesForConversation(db, unsafeCourseScope(courseAId), created.id);
    expect(forward.map((m) => (m.parts as { text: string }[])[0]?.text)).toEqual(["a", "b", "c", "d"]);
    const backward = await getLastMessages(db, unsafeCourseScope(courseAId), created.id, 4);
    expect(backward.map((m) => (m.parts as { text: string }[])[0]?.text)).toEqual(["d", "c", "b", "a"]);
  });

  // #215
  describe("pagination", () => {
    it("getMessagesForConversation limits to the most recent page in chronological order, and `before` pages further back", async () => {
      const created = await createConversation(db, unsafeCourseScope(courseAId), {
        ownerUserId: userId,
        sectionId: null,
        kind: "tutor",
        title: "Messages pagination target",
      });
      const inserted = [];
      for (const text of ["1", "2", "3", "4", "5"]) {
        inserted.push(
          await appendMessage(db, unsafeCourseScope(courseAId), created.id, {
            role: "user",
            parts: [{ type: "text", text }],
          }),
        );
      }

      const lastPage = await getMessagesForConversation(db, unsafeCourseScope(courseAId), created.id, { limit: 2 });
      expect(lastPage.map((m) => (m.parts as { text: string }[])[0]?.text)).toEqual(["4", "5"]);

      const olderPage = await getMessagesForConversation(db, unsafeCourseScope(courseAId), created.id, {
        limit: 2,
        before: inserted[3]!.row.seq,
      });
      expect(olderPage.map((m) => (m.parts as { text: string }[])[0]?.text)).toEqual(["2", "3"]);
    });

    it("listConversationsForOwner respects limit and before (updatedAt cursor)", async () => {
      const c1 = await createConversation(db, unsafeCourseScope(courseAId), {
        ownerUserId: userId,
        sectionId: null,
        kind: "tutor",
        title: "Pagination: first",
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const c2 = await createConversation(db, unsafeCourseScope(courseAId), {
        ownerUserId: userId,
        sectionId: null,
        kind: "tutor",
        title: "Pagination: second",
      });

      const firstPage = await listConversationsForOwner(db, unsafeCourseScope(courseAId), userId, {
        limit: 1,
        kind: "tutor",
      });
      expect(firstPage).toHaveLength(1);
      expect(firstPage[0]!.id).toBe(c2.id); // most recently updated first

      const secondPage = await listConversationsForOwner(db, unsafeCourseScope(courseAId), userId, {
        limit: 5,
        kind: "tutor",
        before: { updatedAt: firstPage[0]!.updatedAt, id: firstPage[0]!.id },
      });
      expect(secondPage.map((r) => r.id)).toContain(c1.id);
      expect(secondPage.map((r) => r.id)).not.toContain(c2.id);
    });

    // #281: the test above forces distinct timestamps via a real 5ms sleep
    // -- exactly the workaround the issue named as evidence the tiebreaker
    // was missing. This test instead forces a genuine TIE (two rows with
    // the identical updated_at) and proves the compound (updatedAt, id)
    // cursor still partitions them correctly across pages: the tied row
    // must land on exactly one page, never both (duplicated) and never
    // neither (silently dropped -- the actual bug this issue is about).
    // Real wall-clock timing can't reliably reproduce a tie on demand, so
    // the tie is set directly rather than raced for.
    it("distinguishes tied updatedAt values via the id tiebreaker, with no duplicate or dropped row", async () => {
      const c1 = await createConversation(db, unsafeCourseScope(courseAId), {
        ownerUserId: userId,
        sectionId: null,
        kind: "tutor",
        title: "Tie: first",
      });
      const c2 = await createConversation(db, unsafeCourseScope(courseAId), {
        ownerUserId: userId,
        sectionId: null,
        kind: "tutor",
        title: "Tie: second",
      });
      // Far-future, not just "earlier than now" -- this DB is shared across
      // this file's other tests, which create their own tutor conversations
      // with real (roughly "now") updatedAt values. A tied timestamp that
      // merely predates those would sort BEHIND them, breaking the
      // "firstPage[0] is one of the two tied rows" assumption below for
      // reasons that have nothing to do with the tiebreaker being tested.
      const tiedTimestamp = new Date("2099-01-01T00:00:00.000Z");
      await db
        .update(conversations)
        .set({ updatedAt: tiedTimestamp })
        .where(inArray(conversations.id, [c1.id, c2.id]));

      const firstPage = await listConversationsForOwner(db, unsafeCourseScope(courseAId), userId, {
        limit: 1,
        kind: "tutor",
      });
      expect(firstPage).toHaveLength(1);
      expect([c1.id, c2.id]).toContain(firstPage[0]!.id);

      const secondPage = await listConversationsForOwner(db, unsafeCourseScope(courseAId), userId, {
        limit: 5,
        kind: "tutor",
        before: { updatedAt: firstPage[0]!.updatedAt, id: firstPage[0]!.id },
      });

      const allIds = [...firstPage, ...secondPage].map((r) => r.id);
      expect(allIds).toContain(c1.id);
      expect(allIds).toContain(c2.id);
      expect(new Set(allIds).size).toBe(allIds.length);
    });
  });

  describe("getOwnedConversationOrNull", () => {
    const alwaysMember = () => true;

    it("returns the row when it exists, is owned, and is not soft-deleted", async () => {
      const created = await createConversation(db, unsafeCourseScope(courseAId), {
        ownerUserId: userId,
        sectionId: null,
        kind: "tutor",
        title: "Owned and findable",
      });
      const found = await getOwnedConversationOrNull(db, created.id, userId, alwaysMember);
      expect(found?.id).toBe(created.id);
    });

    it("returns null when owned by a different user", async () => {
      const created = await createConversation(db, unsafeCourseScope(courseAId), {
        ownerUserId: userId,
        sectionId: null,
        kind: "tutor",
        title: "Not owned by otherUserId",
      });
      const found = await getOwnedConversationOrNull(db, created.id, otherUserId, alwaysMember);
      expect(found).toBeNull();
    });

    it("returns null for a nonexistent id", async () => {
      const found = await getOwnedConversationOrNull(
        db,
        "00000000-0000-0000-0000-000000000000",
        userId,
        alwaysMember,
      );
      expect(found).toBeNull();
    });

    it("returns null when the row is owned but soft-deleted", async () => {
      const created = await createConversation(db, unsafeCourseScope(courseAId), {
        ownerUserId: userId,
        sectionId: null,
        kind: "tutor",
        title: "Owned but soft-deleted",
      });
      await softDeleteConversation(db, unsafeCourseScope(courseAId), created.id);
      const found = await getOwnedConversationOrNull(db, created.id, userId, alwaysMember);
      expect(found).toBeNull();
    });

    // #263: a dropped/removed course member kept full access because every
    // *existing*-conversation path minted its scope straight from the row,
    // never consulting membership -- only the *creation* path checked it.
    it("returns null when the caller owns the row but is no longer a member of its course", async () => {
      const created = await createConversation(db, unsafeCourseScope(courseAId), {
        ownerUserId: userId,
        sectionId: null,
        kind: "tutor",
        title: "Owned, but the course was dropped",
      });
      const found = await getOwnedConversationOrNull(db, created.id, userId, () => false);
      expect(found).toBeNull();
    });
  });

  // #317 review, #322: the per-conversation turn lock chat.ts now acquires
  // before its idempotency read, closing the race where two concurrent
  // sends interleaved into Q_a, Q_b, A_a, A_b with no ordering guarantee.
  describe("acquireConversationTurnLock / releaseConversationTurnLock (#322)", () => {
    async function makeLockableConversation() {
      const created = await createConversation(db, unsafeCourseScope(courseAId), {
        ownerUserId: userId,
        sectionId: null,
        kind: "tutor",
        title: "Lock test conversation",
      });
      return created.id;
    }

    it("grants the lock when none is held", async () => {
      const id = await makeLockableConversation();
      await expect(acquireConversationTurnLock(db, id, 90_000)).resolves.toBe(true);
    });

    it("refuses a second acquisition while the first is still held", async () => {
      const id = await makeLockableConversation();
      await expect(acquireConversationTurnLock(db, id, 90_000)).resolves.toBe(true);
      await expect(acquireConversationTurnLock(db, id, 90_000)).resolves.toBe(false);
    });

    it("grants the lock again after it's released", async () => {
      const id = await makeLockableConversation();
      await acquireConversationTurnLock(db, id, 90_000);
      await releaseConversationTurnLock(db, id);
      await expect(acquireConversationTurnLock(db, id, 90_000)).resolves.toBe(true);
    });

    // The abandoned-lock escape hatch: a Worker killed mid-request never
    // calls releaseConversationTurnLock, so without this a conversation
    // would stay permanently locked. staleMs=0 makes any already-held lock
    // immediately eligible for reclaim, without needing to wait a real
    // 90 seconds in a test.
    it("treats a lock older than staleMs as abandoned and grants a new one", async () => {
      const id = await makeLockableConversation();
      await expect(acquireConversationTurnLock(db, id, 90_000)).resolves.toBe(true);
      await expect(acquireConversationTurnLock(db, id, 0)).resolves.toBe(true);
    });

    it("does not treat a lock younger than staleMs as abandoned", async () => {
      const id = await makeLockableConversation();
      await expect(acquireConversationTurnLock(db, id, 90_000)).resolves.toBe(true);
      await expect(acquireConversationTurnLock(db, id, 90_000)).resolves.toBe(false);
    });

    it("releasing a conversation with no held lock is a harmless no-op", async () => {
      const id = await makeLockableConversation();
      await expect(releaseConversationTurnLock(db, id)).resolves.toBeUndefined();
      await expect(acquireConversationTurnLock(db, id, 90_000)).resolves.toBe(true);
    });

    // Real concurrency, same rationale as rateLimits.test.ts's own
    // "under real concurrency" test: the conditional UPDATE is the thing
    // that makes this race-safe, and that guarantee is only actually
    // proven by real simultaneous requests hitting real Postgres, not by
    // sequential awaits that never overlap.
    it("under real concurrency, exactly one of N parallel acquisitions succeeds", async () => {
      const id = await makeLockableConversation();
      const results = await Promise.all(
        Array.from({ length: 8 }, () => acquireConversationTurnLock(db, id, 90_000)),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
    });
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
