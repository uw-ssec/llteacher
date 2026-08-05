import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { makeNodeDb } from "../../db/nodeClient";
import type { Db } from "../../db/client";
import { organizations, courses, users, courseMemberships, homeworks, sections } from "../../db/schema";
import { unsafeCourseScope } from "./scope";
import {
  listConversationsForOwner,
  createConversation,
  softDeleteConversation,
  appendMessage,
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
    ).rejects.toThrow();
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
    ).rejects.toThrow();
  });

  it("rejects an ownerUserId that is not a member of the scoped course", async () => {
    await expect(
      createConversation(db, unsafeCourseScope(courseAId), {
        ownerUserId: otherUserId,
        sectionId: null,
        kind: "tutor",
        title: "Should not be created",
      }),
    ).rejects.toThrow();
  });

  it("rejects a dropped owner even though a membership row exists (#139)", async () => {
    await expect(
      createConversation(db, unsafeCourseScope(courseAId), {
        ownerUserId: droppedUserId,
        sectionId: null,
        kind: "tutor",
        title: "Should not be created",
      }),
    ).rejects.toThrow();
  });

  it("rejects a sectionId that belongs to a different course", async () => {
    await expect(
      createConversation(db, unsafeCourseScope(courseAId), {
        ownerUserId: userId,
        sectionId: sectionBId,
        kind: "section",
        title: "Should not be created",
      }),
    ).rejects.toThrow();
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
