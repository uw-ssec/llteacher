/* --------------------------------------------------------------------------
   Section-conversation lifecycle against a real Postgres (#27), plus the
   end-to-end verification #22 and #23 have been waiting on.

   #22 (submit) and #23 (submissions matrix) shipped in PR #154 but had never
   run against a real section conversation, because nothing created one --
   #27's start route is the first thing that does. Their final acceptance
   criterion is exactly this: drive submit and the matrix against real
   conversation data. That is the last three tests in this file.
   -------------------------------------------------------------------------- */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { makeNodeDb } from "../../db/nodeClient";
import type { Db } from "../../db/client";
import { unsafeCourseScope, unsafeOrgScope } from "./scope";
import {
  startSectionConversation,
  restartSectionConversation,
  getActiveSectionConversation,
  getSectionConversationMessages,
  SectionConversationExistsError,
  SectionNotFoundError,
  SectionNotInteractiveError,
} from "./sectionConversations";
import { submitSection, getHomeworkSubmissionsMatrix } from "./submissions";
import { softDeleteConversation, appendMessage } from "./conversations";
import { IdentityCipher } from "../../lib/crypto/identity-cipher";
import { loadIdentityCipherKeys } from "../../lib/secrets-loader";
import {
  organizations,
  courses,
  users,
  courseMemberships,
  homeworks,
  sections,
  conversations,
} from "../../db/schema";

const RAW_DATABASE_URL = process.env.DATABASE_URL;

function randomBytes(): never {
  return crypto.getRandomValues(new Uint8Array(16)) as never;
}

describe.skipIf(!RAW_DATABASE_URL)("section conversation lifecycle (real DB, #27)", () => {
  let db: Db;
  let cipher: IdentityCipher;
  let orgId: string;
  let courseId: string;
  let homeworkId: string;
  let sectionId: string;
  let nonInteractiveSectionId: string;
  let studentId: string;
  let instructorId: string;

  beforeAll(async () => {
    db = makeNodeDb(RAW_DATABASE_URL!);
    cipher = new IdentityCipher(
      await loadIdentityCipherKeys({
        ENCRYPTION_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
        BLIND_INDEX_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
      } as Env),
    );

    const [org] = await db
      .insert(organizations)
      .values({
        name: "27-org",
        slug: `s27-${crypto.randomUUID().slice(0, 8)}`,
        workosOrganizationId: `org_${crypto.randomUUID().slice(0, 8)}`,
      })
      .returning({ id: organizations.id });
    orgId = org!.id;

    const [course] = await db
      .insert(courses)
      .values({ organizationId: orgId, code: `C-${crypto.randomUUID().slice(0, 8)}`, term: "T", title: "t" })
      .returning({ id: courses.id });
    courseId = course!.id;

    // Encrypted for real: getHomeworkSubmissionsMatrix decrypts every roster
    // row, so random bytes would fail the cipher rather than the assertion.
    const [student] = await db
      .insert(users)
      .values({
        email: await cipher.encryptString("student@test.com"),
        emailBlindIndex: await cipher.computeBlindIndex("student@test.com"),
      })
      .returning({ id: users.id });
    studentId = student!.id;
    await db.insert(courseMemberships).values({ userId: studentId, courseId, role: "student" });

    const [instructor] = await db
      .insert(users)
      .values({ email: randomBytes(), emailBlindIndex: randomBytes() })
      .returning({ id: users.id });
    instructorId = instructor!.id;
    const [instructorMembership] = await db
      .insert(courseMemberships)
      .values({ userId: instructorId, courseId, role: "instructor" })
      .returning({ id: courseMemberships.id });

    const [hw] = await db
      .insert(homeworks)
      .values({
        courseId,
        createdById: instructorMembership!.id,
        title: "hw",
        description: "d",
        dueDate: new Date(Date.now() + 86_400_000),
        publishedAt: new Date(Date.now() - 86_400_000),
      })
      .returning({ id: homeworks.id });
    homeworkId = hw!.id;

    const [section] = await db
      .insert(sections)
      .values({ homeworkId, title: "Confidence intervals", content: "Estimate the mean.", order: 2 })
      .returning({ id: sections.id });
    sectionId = section!.id;

    const [nonInteractive] = await db
      .insert(sections)
      .values({ homeworkId, title: "Read this", content: "c", order: 3, type: "non_interactive" })
      .returning({ id: sections.id });
    nonInteractiveSectionId = nonInteractive!.id;
  });

  afterAll(async () => {
    if (orgId) await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  async function reset() {
    await db.delete(conversations).where(eq(conversations.ownerUserId, studentId));
    await db.delete(conversations).where(eq(conversations.ownerUserId, instructorId));
  }

  it("starts a conversation with the Django-parity greeting as its first message", async () => {
    await reset();
    const scope = unsafeCourseScope(courseId);

    const created = await startSectionConversation(db, scope, {
      sectionId,
      ownerUserId: studentId,
      isTeacherTest: false,
      canViewDrafts: true,
    });

    expect(created.title).toBe("Section 2: Confidence intervals");

    const messages = await getSectionConversationMessages(db, created.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("assistant");
    expect(messages[0]!.parts).toEqual([
      {
        type: "text",
        text: "Hello! I'm here to help you with Section 2: Confidence intervals.\n\nEstimate the mean.\n\nHow can I assist you with this question?",
      },
    ]);
  });

  // #283: getSectionConversationMessages was still ordering by `createdAt`
  // while repositories/conversations.ts's getLastMessages/
  // getMessagesForConversation had already moved to `seq` (#221) -- this
  // conversation's own first two rows (the greeting + a reply) are written
  // in a single atomic db.batch group by startSectionConversation, which is
  // exactly the "batched writes" condition ARCHITECTURE.md's Message
  // Ordering section names as when createdAt stops being a safe sole
  // ordering key. Asserting on `seq` order directly (not just createdAt,
  // which two batched rows could plausibly still share or reverse under a
  // real driver) is what actually exercises the fix.
  it("orders messages by seq, including the batch-written greeting", async () => {
    await reset();
    const scope = unsafeCourseScope(courseId);
    const created = await startSectionConversation(db, scope, {
      sectionId,
      ownerUserId: studentId,
      isTeacherTest: false,
      canViewDrafts: true,
    });
    const [greeting] = await getSectionConversationMessages(db, created.id);
    const { row: userMsg } = await appendMessage(db, scope, created.id, {
      role: "user",
      parts: [{ type: "text", text: "question" }],
    });
    const { row: assistantMsg } = await appendMessage(db, scope, created.id, {
      role: "assistant",
      parts: [{ type: "text", text: "answer" }],
    });

    const messages = await getSectionConversationMessages(db, created.id);
    expect(messages.map((m) => m.id)).toEqual([greeting!.id, userMsg.id, assistantMsg.id]);
    expect(messages.map((m) => m.seq)).toEqual([...messages.map((m) => m.seq)].sort((a, b) => a - b));
  });

  // #317 review, #326: was completely unbounded before this pass -- same
  // "limits to the most recent page in chronological order, `before` pages
  // further back" shape as conversations.test.ts's getMessagesForConversation
  // pagination coverage, since both now share one convention.
  it("limits to the most recent page in chronological order, and `before` pages further back (#326)", async () => {
    await reset();
    const scope = unsafeCourseScope(courseId);
    const created = await startSectionConversation(db, scope, {
      sectionId,
      ownerUserId: studentId,
      isTeacherTest: false,
      canViewDrafts: true,
    });
    // The greeting is row 1; append four more so there are 5 total.
    const inserted = [];
    for (const text of ["1", "2", "3", "4"]) {
      inserted.push(await appendMessage(db, scope, created.id, { role: "user", parts: [{ type: "text", text }] }));
    }

    const lastPage = await getSectionConversationMessages(db, created.id, { limit: 2 });
    expect(lastPage.map((m) => (m.parts as { text: string }[])[0]?.text)).toEqual(["3", "4"]);

    const olderPage = await getSectionConversationMessages(db, created.id, {
      limit: 2,
      before: inserted[2]!.row.seq,
    });
    expect(olderPage.map((m) => (m.parts as { text: string }[])[0]?.text)).toEqual(["1", "2"]);
  });

  it("refuses a second active conversation on the same section", async () => {
    await reset();
    const scope = unsafeCourseScope(courseId);
    await startSectionConversation(db, scope, { sectionId, ownerUserId: studentId, isTeacherTest: false, canViewDrafts: true });

    await expect(
      startSectionConversation(db, scope, { sectionId, ownerUserId: studentId, isTeacherTest: false, canViewDrafts: true }),
    ).rejects.toBeInstanceOf(SectionConversationExistsError);
  });

  it("refuses a conversation on a non_interactive section", async () => {
    await reset();
    // #164: that section type collects a single answer and never has a chat.
    await expect(
      startSectionConversation(db, unsafeCourseScope(courseId), {
        sectionId: nonInteractiveSectionId,
        ownerUserId: studentId,
        isTeacherTest: false,
        canViewDrafts: true,
      }),
    ).rejects.toBeInstanceOf(SectionNotInteractiveError);
  });

  it("refuses a conversation for a non-member", async () => {
    await reset();
    const [outsider] = await db
      .insert(users)
      .values({ email: randomBytes(), emailBlindIndex: randomBytes() })
      .returning({ id: users.id });

    await expect(
      startSectionConversation(db, unsafeCourseScope(courseId), {
        sectionId,
        ownerUserId: outsider!.id,
        isTeacherTest: false,
        canViewDrafts: true,
      }),
      // #236/#241: a non-member gets the same SectionNotFoundError a genuinely
      // missing section produces -- deliberately indistinguishable, so the
      // error cannot be used to probe which sections exist.
    ).rejects.toBeInstanceOf(SectionNotFoundError);

    await db.delete(users).where(eq(users.id, outsider!.id));
  });

  // #317 review, blocking finding #4: same "indistinguishable from missing"
  // rule as the non-member case above, now for an unreleased homework's
  // section -- the greeting startSectionConversation writes would otherwise
  // leak the draft's problem statement to a student who merely holds the
  // section's UUID from before it was withdrawn.
  it("refuses a conversation on an unreleased (draft) section's homework for a caller without draft access", async () => {
    await reset();
    const [instructorMembershipRow] = await db
      .select({ id: courseMemberships.id })
      .from(courseMemberships)
      .where(eq(courseMemberships.userId, instructorId));
    const [draftHw] = await db
      .insert(homeworks)
      .values({
        courseId,
        createdById: instructorMembershipRow!.id,
        title: "draft hw",
        description: "d",
        dueDate: new Date(Date.now() + 86_400_000),
        publishedAt: null, // #317: unpublished -- deriveHomeworkStatus resolves this to "draft"
      })
      .returning({ id: homeworks.id });
    const [draftSection] = await db
      .insert(sections)
      .values({ homeworkId: draftHw!.id, title: "Draft section", content: "secret content", order: 1 })
      .returning({ id: sections.id });

    await expect(
      startSectionConversation(db, unsafeCourseScope(courseId), {
        sectionId: draftSection!.id,
        ownerUserId: studentId,
        isTeacherTest: false,
        canViewDrafts: false,
      }),
    ).rejects.toBeInstanceOf(SectionNotFoundError);

    // canViewDrafts: true (an instructor previewing their own draft) is the
    // documented bypass -- must still succeed.
    const created = await startSectionConversation(db, unsafeCourseScope(courseId), {
      sectionId: draftSection!.id,
      ownerUserId: instructorId,
      isTeacherTest: true,
      canViewDrafts: true,
    });
    expect(created.title).toBe("Section 1: Draft section");

    await db.delete(homeworks).where(eq(homeworks.id, draftHw!.id));
  });

  it("records an instructor's conversation as a teacher test", async () => {
    await reset();
    const created = await startSectionConversation(db, unsafeCourseScope(courseId), {
      sectionId,
      ownerUserId: instructorId,
      isTeacherTest: true,
      canViewDrafts: true,
    });

    const [row] = await db.select().from(conversations).where(eq(conversations.id, created.id));
    expect(row!.isTeacherTest).toBe(true);
  });

  it("restart replaces the conversation and leaves exactly one active", async () => {
    await reset();
    const scope = unsafeCourseScope(courseId);
    const first = await startSectionConversation(db, scope, {
      sectionId,
      ownerUserId: studentId,
      isTeacherTest: false,
      canViewDrafts: true,
    });

    const { conversation } = await restartSectionConversation(
      db,
      unsafeOrgScope(orgId),
      first.id,
      studentId,
      true,
    );

    expect(conversation.id).not.toBe(first.id);

    const active = await getActiveSectionConversation(db, scope, sectionId, studentId);
    expect(active!.id).toBe(conversation.id);

    // The replacement opens with its own greeting, not an empty transcript.
    const messages = await getSectionConversationMessages(db, conversation.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("assistant");
  });

  /* ------- the fail-closed guard on the bare soft-delete (#128) ------- */

  it("softDeleteConversation refuses a submitted section conversation", async () => {
    await reset();
    const started = await startSectionConversation(db, unsafeCourseScope(courseId), {
      sectionId,
      ownerUserId: studentId,
      isTeacherTest: false,
      canViewDrafts: true,
    });
    await submitSection(db, unsafeOrgScope(orgId), started.id, studentId);

    // The door #128 would otherwise stay open through: a plain soft-delete
    // leaves the submission row alive against a conversation the student can
    // no longer see, and the replacement's submit then makes two.
    await expect(
      softDeleteConversation(db, unsafeCourseScope(courseId), started.id),
    ).rejects.toThrow(/restartSectionConversation/);

    const [still] = await db.select().from(conversations).where(eq(conversations.id, started.id));
    expect(still!.isDeleted).toBe(false);
  });

  it("softDeleteConversation still works on an unsubmitted section conversation", async () => {
    await reset();
    const started = await startSectionConversation(db, unsafeCourseScope(courseId), {
      sectionId,
      ownerUserId: studentId,
      isTeacherTest: false,
      canViewDrafts: true,
    });

    await expect(
      softDeleteConversation(db, unsafeCourseScope(courseId), started.id),
    ).resolves.toBeDefined();

    const [row] = await db.select().from(conversations).where(eq(conversations.id, started.id));
    expect(row!.isDeleted).toBe(true);
  });

  it("softDeleteConversation still works on a tutor conversation", async () => {
    await reset();
    const [tutor] = await db
      .insert(conversations)
      .values({ ownerUserId: studentId, courseId, sectionId: null, kind: "tutor", title: "t" })
      .returning({ id: conversations.id });

    await expect(
      softDeleteConversation(db, unsafeCourseScope(courseId), tutor!.id),
    ).resolves.toBeDefined();
  });

  /* ---------------- #22 / #23 end-to-end verification ---------------- */

  it("#22: submits a real section conversation, then resubmits in place", async () => {
    await reset();
    const started = await startSectionConversation(db, unsafeCourseScope(courseId), {
      sectionId,
      ownerUserId: studentId,
      isTeacherTest: false,
      canViewDrafts: true,
    });
    const orgScope = unsafeOrgScope(orgId);

    const first = await submitSection(db, orgScope, started.id, studentId);
    expect(first.isResubmission).toBe(false);

    const second = await submitSection(db, orgScope, started.id, studentId);
    expect(second.isResubmission).toBe(true);
    // Resubmit replaces in place -- same row, not a second one.
    expect(second.id).toBe(first.id);
  });

  it("#22: refuses to submit a teacher test conversation (Django can_submit parity)", async () => {
    await reset();
    const started = await startSectionConversation(db, unsafeCourseScope(courseId), {
      sectionId,
      ownerUserId: instructorId,
      isTeacherTest: true,
      canViewDrafts: true,
    });

    await expect(
      submitSection(db, unsafeOrgScope(orgId), started.id, instructorId),
    ).rejects.toThrow(/Teacher test/);
  });

  it("#23: the submissions matrix reports the real conversation and submission", async () => {
    await reset();
    const started = await startSectionConversation(db, unsafeCourseScope(courseId), {
      sectionId,
      ownerUserId: studentId,
      isTeacherTest: false,
      canViewDrafts: true,
    });
    await submitSection(db, unsafeOrgScope(orgId), started.id, studentId);

    const matrix = await getHomeworkSubmissionsMatrix(
      db,
      unsafeCourseScope(courseId),
      cipher,
      homeworkId,
    );

    expect(matrix).not.toBeNull();
    const row = matrix!.students.find((s) => s.email === "student@test.com");
    expect(row).toBeDefined();
    const cell = row!.sections.find((cl) => cl.sectionId === sectionId);
    expect(cell!.status).toBe("submitted");
    expect(cell!.conversationCount).toBe(1);
  });
});
