import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { makeNodeDb } from "../../db/nodeClient";
import type { Db } from "../../db/client";
import { organizations, courses, users, homeworks, sections, courseMemberships, conversations, hintBudgets } from "../../db/schema";
import { unsafeOrgScope, unsafeCourseScope } from "./scope";
import { getHintCount, getSectionHintLimit, getSectionHintStatus, recordHintRequest, HINT_IDEMPOTENCY_WINDOW_MS } from "./hints";

const DATABASE_URL = process.env.DATABASE_URL;

// #80: real-DB repository tests -- same rationale/pattern as
// sectionAnswers.test.ts (DATABASE_URL-gated, skipped in a fast-test-only
// run). recordHintRequest's own doc comment explains why this isn't mocked:
// the behavior under test IS the SQL (a race-prone count-then-compare
// budget check, an idempotency window, tenancy-verified reads), not
// chatHandler's wiring of it (that part is covered separately in
// chat.test.ts with a mocked repository).
describe.skipIf(!DATABASE_URL)("hints repository (#80)", () => {
  let db: Db;
  let orgId: string;
  let courseId: string;
  let membershipId: string;
  let studentAId: string;
  let studentBId: string;

  beforeAll(async () => {
    db = makeNodeDb(DATABASE_URL!);
    const [org] = await db
      .insert(organizations)
      .values({ slug: `hints-repo-${crypto.randomUUID()}`, name: "Org", workosOrganizationId: `w-${crypto.randomUUID()}` })
      .returning({ id: organizations.id });
    orgId = org.id;
    const [course] = await db
      .insert(courses)
      .values({ organizationId: orgId, code: "C", term: "T", title: "T" })
      .returning({ id: courses.id });
    courseId = course.id;

    const instructorEmail = crypto.getRandomValues(new Uint8Array(32));
    const [instructor] = await db
      .insert(users)
      .values({ email: instructorEmail as never, emailBlindIndex: instructorEmail as never })
      .returning({ id: users.id });
    const [membership] = await db
      .insert(courseMemberships)
      .values({ userId: instructor.id, courseId, role: "instructor" })
      .returning({ id: courseMemberships.id });
    membershipId = membership.id;

    const emailA = crypto.getRandomValues(new Uint8Array(32));
    const [userA] = await db.insert(users).values({ email: emailA as never, emailBlindIndex: emailA as never }).returning({ id: users.id });
    studentAId = userA.id;
    await db.insert(courseMemberships).values({ userId: studentAId, courseId, role: "student" });

    const emailB = crypto.getRandomValues(new Uint8Array(32));
    const [userB] = await db.insert(users).values({ email: emailB as never, emailBlindIndex: emailB as never }).returning({ id: users.id });
    studentBId = userB.id;
    await db.insert(courseMemberships).values({ userId: studentBId, courseId, role: "student" });
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  async function newSectionWithConversation(studentId: string, maxHints?: number | null) {
    const [hw] = await db
      .insert(homeworks)
      .values({ courseId, createdById: membershipId, title: "h", description: "d", dueDate: new Date() })
      .returning({ id: homeworks.id });
    const [section] = await db
      .insert(sections)
      .values({ homeworkId: hw.id, order: 1, title: "s", content: "c" })
      .returning({ id: sections.id });
    if (maxHints !== undefined) {
      await db.insert(hintBudgets).values({ sectionId: section.id, organizationId: orgId, maxHints });
    }
    const [conv] = await db
      .insert(conversations)
      .values({ ownerUserId: studentId, courseId, sectionId: section.id, kind: "section", title: "Section 1" })
      .returning({ id: conversations.id });
    return { sectionId: section.id, conversationId: conv.id };
  }

  // Spaces successive recordHintRequest calls well outside the idempotency
  // window so each is treated as a genuinely new request -- the deliberate
  // choice of an explicit `now` param (recordHintRequest's own doc comment)
  // is exactly what makes this possible without a real sleep.
  function spaced(base: number, i: number) {
    return new Date(base + i * (HINT_IDEMPOTENCY_WINDOW_MS + 1000));
  }

  it("grants hints up to the configured limit, then denies the next one and records no event for it", async () => {
    const { sectionId, conversationId } = await newSectionWithConversation(studentAId, 3);
    const base = Date.now();

    for (let i = 0; i < 3; i++) {
      const result = await recordHintRequest(
        db,
        unsafeOrgScope(orgId),
        { conversationId, sectionId, studentId: studentAId, promptTemplateId: null },
        spaced(base, i),
      );
      expect(result.status).toBe("hint_provided");
    }
    expect(await getHintCount(db, sectionId, studentAId)).toBe(3);

    const fourth = await recordHintRequest(
      db,
      unsafeOrgScope(orgId),
      { conversationId, sectionId, studentId: studentAId, promptTemplateId: null },
      spaced(base, 3),
    );
    expect(fourth.status).toBe("budget_exceeded");
    expect(fourth.remainingHints).toBe(0);
    // The denied request must not have inserted a row -- count stays at 3.
    expect(await getHintCount(db, sectionId, studentAId)).toBe(3);
  });

  it("is unlimited when the section has no hint_budgets row at all", async () => {
    const { sectionId, conversationId } = await newSectionWithConversation(studentAId);
    expect(await getSectionHintLimit(db, sectionId)).toBeNull();

    const base = Date.now();
    for (let i = 0; i < 5; i++) {
      const result = await recordHintRequest(
        db,
        unsafeOrgScope(orgId),
        { conversationId, sectionId, studentId: studentAId, promptTemplateId: null },
        spaced(base, i),
      );
      expect(result.status).toBe("hint_provided");
      expect(result.remainingHints).toBeNull();
    }
    expect(await getHintCount(db, sectionId, studentAId)).toBe(5);
  });

  it("treats a repeated request within the idempotency window as one event, not two", async () => {
    const { sectionId, conversationId } = await newSectionWithConversation(studentAId, 3);
    const t0 = new Date();

    const first = await recordHintRequest(db, unsafeOrgScope(orgId), { conversationId, sectionId, studentId: studentAId, promptTemplateId: null }, t0);
    expect(first.status).toBe("hint_provided");
    expect(first.deduped).toBe(false);

    // Same conversation/student, well within the 2s window.
    const secondNow = new Date(t0.getTime() + 500);
    const second = await recordHintRequest(
      db,
      unsafeOrgScope(orgId),
      { conversationId, sectionId, studentId: studentAId, promptTemplateId: null },
      secondNow,
    );
    expect(second.status).toBe("hint_provided");
    expect(second.deduped).toBe(true);

    // Only ONE row exists -- the dedup path did not insert a second event.
    expect(await getHintCount(db, sectionId, studentAId)).toBe(1);

    // A third request past the window IS a new, real grant.
    const thirdNow = new Date(t0.getTime() + HINT_IDEMPOTENCY_WINDOW_MS + 1);
    const third = await recordHintRequest(
      db,
      unsafeOrgScope(orgId),
      { conversationId, sectionId, studentId: studentAId, promptTemplateId: null },
      thirdNow,
    );
    expect(third.status).toBe("hint_provided");
    expect(third.deduped).toBe(false);
    expect(await getHintCount(db, sectionId, studentAId)).toBe(2);
  });

  it("scopes budget usage per (section, student) -- student A's hints do not decrement student B's", async () => {
    const { sectionId, conversationId: convA } = await newSectionWithConversation(studentAId, 2);
    // Student B needs their own conversation on the SAME section.
    const [convBRow] = await db
      .insert(conversations)
      .values({ ownerUserId: studentBId, courseId, sectionId, kind: "section", title: "Section 1", isTeacherTest: false })
      .returning({ id: conversations.id });
    const convB = convBRow.id;

    const base = Date.now();
    await recordHintRequest(db, unsafeOrgScope(orgId), { conversationId: convA, sectionId, studentId: studentAId, promptTemplateId: null }, spaced(base, 0));
    await recordHintRequest(db, unsafeOrgScope(orgId), { conversationId: convA, sectionId, studentId: studentAId, promptTemplateId: null }, spaced(base, 1));

    expect(await getHintCount(db, sectionId, studentAId)).toBe(2);
    // Student A is now at their 2-hint limit -- a 3rd request is denied.
    const denied = await recordHintRequest(
      db,
      unsafeOrgScope(orgId),
      { conversationId: convA, sectionId, studentId: studentAId, promptTemplateId: null },
      spaced(base, 2),
    );
    expect(denied.status).toBe("budget_exceeded");

    // Student B, same section, has used none of their own budget.
    expect(await getHintCount(db, sectionId, studentBId)).toBe(0);
    const bResult = await recordHintRequest(
      db,
      unsafeOrgScope(orgId),
      { conversationId: convB, sectionId, studentId: studentBId, promptTemplateId: null },
      spaced(base, 3),
    );
    expect(bResult.status).toBe("hint_provided");
    expect(await getHintCount(db, sectionId, studentBId)).toBe(1);
    // Student A's own count is unaffected by B's request.
    expect(await getHintCount(db, sectionId, studentAId)).toBe(2);
  });

  it("getSectionHintStatus returns count/limit/remaining, tenancy-verified", async () => {
    const { sectionId, conversationId } = await newSectionWithConversation(studentAId, 3);
    await recordHintRequest(db, unsafeOrgScope(orgId), { conversationId, sectionId, studentId: studentAId, promptTemplateId: null }, new Date());

    const status = await getSectionHintStatus(db, unsafeCourseScope(courseId), sectionId, studentAId);
    expect(status).toEqual({ count: 1, limit: 3, remaining: 2 });
  });

  it("getSectionHintStatus returns null for a section outside the given course scope", async () => {
    const [otherCourse] = await db.insert(courses).values({ organizationId: orgId, code: "C2", term: "T", title: "T2" }).returning({ id: courses.id });
    const { sectionId } = await newSectionWithConversation(studentAId);
    const status = await getSectionHintStatus(db, unsafeCourseScope(otherCourse.id), sectionId, studentAId);
    expect(status).toBeNull();
  });
});
