/* --------------------------------------------------------------------------
   Student feedback flags on AI tutor responses (#90), against a real
   Postgres -- the DB-gated half of this task's testing strategy: the
   one-flag-per-message-per-student UNIQUE INDEX (an application-level
   mock can't prove a real constraint exists) and listCourseFeedback's
   strict course-scoping join (two real courses, asserting the query
   itself excludes the other one's rows, not just that a route-level
   filter would).

   Skipped (describe.skipIf) whenever DATABASE_URL isn't set, matching
   every other `.db.test.ts` in this repository -- see this task's own
   report for why this suite could not be run in the environment it was
   written in.
   -------------------------------------------------------------------------- */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { makeNodeDb } from "../../db/nodeClient";
import type { Db } from "../../db/client";
import { unsafeCourseScope } from "./scope";
import {
  flagResponse,
  getFlaggableAssistantMessage,
  listCourseFeedback,
  ResponseAlreadyFlaggedError,
} from "./responseFeedback";
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
  messages,
  responseFeedback,
} from "../../db/schema";

const RAW_DATABASE_URL = process.env.DATABASE_URL;

function randomBytes(): never {
  return crypto.getRandomValues(new Uint8Array(16)) as never;
}

describe.skipIf(!RAW_DATABASE_URL)("response feedback (real DB, #90)", () => {
  let db: Db;
  let cipher: IdentityCipher;
  let orgId: string;

  // Course A: the course under test.
  let courseAId: string;
  let sectionAId: string;
  let studentAId: string;
  let conversationAId: string;
  let assistantMessageAId: string;

  // Course B: exists purely to prove listCourseFeedback's join excludes it.
  let courseBId: string;
  let studentBId: string;
  let conversationBId: string;
  let assistantMessageBId: string;

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
        name: "90-org",
        slug: `s90-${crypto.randomUUID().slice(0, 8)}`,
        workosOrganizationId: `org_${crypto.randomUUID().slice(0, 8)}`,
      })
      .returning({ id: organizations.id });
    orgId = org!.id;

    async function seedCourse(label: string) {
      const [course] = await db
        .insert(courses)
        .values({ organizationId: orgId, code: `C-${crypto.randomUUID().slice(0, 8)}`, term: "T", title: label })
        .returning({ id: courses.id });
      const courseId = course!.id;

      const [student] = await db
        .insert(users)
        .values({
          email: await cipher.encryptString(`${label}-student@test.com`),
          emailBlindIndex: await cipher.computeBlindIndex(`${label}-student@test.com`),
          displayName: await cipher.encryptString(`${label} Student`),
        })
        .returning({ id: users.id });
      await db.insert(courseMemberships).values({ userId: student!.id, courseId, role: "student" });

      const [instructor] = await db
        .insert(users)
        .values({ email: randomBytes(), emailBlindIndex: randomBytes() })
        .returning({ id: users.id });
      const [instructorMembership] = await db
        .insert(courseMemberships)
        .values({ userId: instructor!.id, courseId, role: "instructor" })
        .returning({ id: courseMemberships.id });

      const [hw] = await db
        .insert(homeworks)
        .values({
          courseId,
          createdById: instructorMembership!.id,
          title: `${label} hw`,
          description: "d",
          dueDate: new Date(Date.now() + 86_400_000),
          publishedAt: new Date(Date.now() - 86_400_000),
        })
        .returning({ id: homeworks.id });

      const [section] = await db
        .insert(sections)
        .values({ homeworkId: hw!.id, title: `${label} section`, content: "c", order: 1 })
        .returning({ id: sections.id });

      const [conversation] = await db
        .insert(conversations)
        .values({ ownerUserId: student!.id, courseId, sectionId: section!.id, kind: "section", title: "t" })
        .returning({ id: conversations.id });

      const [assistantMessage] = await db
        .insert(messages)
        .values({
          conversationId: conversation!.id,
          role: "assistant",
          parts: [{ type: "text", text: `${label}: the answer is 42` }],
        })
        .returning({ id: messages.id });

      return {
        courseId,
        sectionId: section!.id,
        studentId: student!.id,
        instructorId: instructor!.id,
        conversationId: conversation!.id,
        assistantMessageId: assistantMessage!.id,
      };
    }

    const a = await seedCourse("A");
    courseAId = a.courseId;
    sectionAId = a.sectionId;
    studentAId = a.studentId;
    conversationAId = a.conversationId;
    assistantMessageAId = a.assistantMessageId;

    const b = await seedCourse("B");
    courseBId = b.courseId;
    studentBId = b.studentId;
    conversationBId = b.conversationId;
    assistantMessageBId = b.assistantMessageId;
  });

  afterAll(async () => {
    if (orgId) await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  async function resetFeedback() {
    await db.delete(responseFeedback).where(eq(responseFeedback.conversationId, conversationAId));
    await db.delete(responseFeedback).where(eq(responseFeedback.conversationId, conversationBId));
  }

  describe("getFlaggableAssistantMessage", () => {
    it("finds a real assistant message in its own conversation", async () => {
      const found = await getFlaggableAssistantMessage(db, conversationAId, assistantMessageAId);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(assistantMessageAId);
    });

    it("returns null for a message that belongs to a different conversation", async () => {
      const found = await getFlaggableAssistantMessage(db, conversationAId, assistantMessageBId);
      expect(found).toBeNull();
    });

    it("returns null for a nonexistent message id", async () => {
      const found = await getFlaggableAssistantMessage(db, conversationAId, crypto.randomUUID());
      expect(found).toBeNull();
    });

    it("returns null for a user-role message (not the tutor's own turn)", async () => {
      const [userMessage] = await db
        .insert(messages)
        .values({ conversationId: conversationAId, role: "user", parts: [{ type: "text", text: "hi" }] })
        .returning({ id: messages.id });
      const found = await getFlaggableAssistantMessage(db, conversationAId, userMessage!.id);
      expect(found).toBeNull();
    });
  });

  describe("flagResponse", () => {
    beforeAll(resetFeedback);

    it("inserts a flag with the given responseSnapshot", async () => {
      const flag = await flagResponse(db, {
        conversationId: conversationAId,
        messageId: assistantMessageAId,
        studentId: studentAId,
        reason: "incorrect",
        comment: "that's not right",
        responseSnapshot: [{ type: "text", text: "A: the answer is 42" }],
      });
      expect(flag.reason).toBe("incorrect");
      expect(flag.comment).toBe("that's not right");

      const [row] = await db.select().from(responseFeedback).where(eq(responseFeedback.id, flag.id));
      expect(row?.responseSnapshot).toEqual([{ type: "text", text: "A: the answer is 42" }]);
    });

    it("#90: rejects a second flag on the same (message, student) via the DB unique constraint, even without an app-level pre-check", async () => {
      // #90 review (Minor #9): this test now inserts its OWN first flag
      // rather than relying on the previous test's insert to occupy the
      // slot -- the previous version was order-coupled (it would have
      // silently stopped proving anything if this test were ever reordered
      // or run alone, e.g. via `it.only`) and is fixed here so the test is
      // self-contained. The delete below clears the row the PREVIOUS test
      // in this file left behind for the identical (message, student) pair
      // (this describe block resets feedback once in its own beforeAll,
      // not between individual tests), so this test's own "first" insert
      // below cannot itself collide with unrelated state.
      await db
        .delete(responseFeedback)
        .where(
          and(eq(responseFeedback.messageId, assistantMessageAId), eq(responseFeedback.studentId, studentAId)),
        );
      await flagResponse(db, {
        conversationId: conversationAId,
        messageId: assistantMessageAId,
        studentId: studentAId,
        reason: "incorrect",
        comment: null,
        responseSnapshot: [{ type: "text", text: "A: the answer is 42" }],
      });
      await expect(
        flagResponse(db, {
          conversationId: conversationAId,
          messageId: assistantMessageAId,
          studentId: studentAId,
          reason: "confusing",
          comment: null,
          responseSnapshot: [{ type: "text", text: "A: the answer is 42" }],
        }),
      ).rejects.toBeInstanceOf(ResponseAlreadyFlaggedError);
    });

    it("allows a DIFFERENT student to flag the same message", async () => {
      // studentBId is a different course's student, but the constraint is
      // keyed on (messageId, studentId) alone -- irrelevant which course
      // the student belongs to -- so this also stands in for "two
      // different students flagging the same message" without seeding a
      // second student in course A.
      const flag = await flagResponse(db, {
        conversationId: conversationAId,
        messageId: assistantMessageAId,
        studentId: studentBId,
        reason: "other",
        comment: null,
        responseSnapshot: [{ type: "text", text: "A: the answer is 42" }],
      });
      expect(flag.id).toBeTruthy();
      // Clean up so it doesn't leak into listCourseFeedback's course-scope
      // assertions below (this row's conversationId is course A's, so it
      // WOULD show up in course A's list otherwise).
      await db.delete(responseFeedback).where(eq(responseFeedback.id, flag.id));
    });
  });

  describe("listCourseFeedback", () => {
    beforeAll(async () => {
      await resetFeedback();
      await flagResponse(db, {
        conversationId: conversationAId,
        messageId: assistantMessageAId,
        studentId: studentAId,
        reason: "gave_away_answer",
        comment: "told me the number",
        responseSnapshot: [{ type: "text", text: "A: the answer is 42" }],
      });
      await flagResponse(db, {
        conversationId: conversationBId,
        messageId: assistantMessageBId,
        studentId: studentBId,
        reason: "incorrect",
        comment: null,
        responseSnapshot: [{ type: "text", text: "B: the answer is 42" }],
      });
    });

    it("returns only this course's flags, never another course's (strict org/course scoping)", async () => {
      const result = await listCourseFeedback(db, unsafeCourseScope(courseAId), cipher);
      expect(result.total).toBe(1);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.conversationId).toBe(conversationAId);
      expect(result.items[0]!.reason).toBe("gave_away_answer");
      // Not course B's row, by id or by content.
      expect(result.items.some((i) => i.conversationId === conversationBId)).toBe(false);

      const otherCourseResult = await listCourseFeedback(db, unsafeCourseScope(courseBId), cipher);
      expect(otherCourseResult.total).toBe(1);
      expect(otherCourseResult.items[0]!.conversationId).toBe(conversationBId);
    });

    it("decrypts the flagging student's display name", async () => {
      const result = await listCourseFeedback(db, unsafeCourseScope(courseAId), cipher);
      expect(result.items[0]!.studentName).toBe("A Student");
    });

    it("stores and returns the exact responseSnapshot from flag time", async () => {
      const result = await listCourseFeedback(db, unsafeCourseScope(courseAId), cipher);
      expect(result.items[0]!.responseSnapshot).toEqual([{ type: "text", text: "A: the answer is 42" }]);
    });

    it("carries section/homework identity for the dashboard's transcript-context link", async () => {
      const result = await listCourseFeedback(db, unsafeCourseScope(courseAId), cipher);
      expect(result.items[0]!.sectionId).toBe(sectionAId);
      expect(result.items[0]!.homeworkStatus).toBe("active");
    });

    it("survives the underlying message being cleared to NULL (ON DELETE SET NULL) -- the snapshot is still readable", async () => {
      await db.delete(messages).where(eq(messages.id, assistantMessageAId));
      const result = await listCourseFeedback(db, unsafeCourseScope(courseAId), cipher);
      expect(result.total).toBe(1);
      expect(result.items[0]!.messageId).toBeNull();
      expect(result.items[0]!.responseSnapshot).toEqual([{ type: "text", text: "A: the answer is 42" }]);
    });
  });
});
