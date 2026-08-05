import { describe, it, expect } from "vitest";
import { deriveSectionStatus, getStudentHomeworksForUser } from "./studentHomeworks";

describe("deriveSectionStatus", () => {
  const future = new Date("2099-01-01");
  const past = new Date("2020-01-01");

  it("is submitted when a submission exists, regardless of due date", () => {
    expect(deriveSectionStatus({ dueDate: past, hasActiveConversation: true, hasSubmission: true })).toBe("submitted");
    expect(deriveSectionStatus({ dueDate: future, hasActiveConversation: true, hasSubmission: true })).toBe("submitted");
  });

  it("is in_progress when a conversation exists, not submitted, due date in future", () => {
    expect(deriveSectionStatus({ dueDate: future, hasActiveConversation: true, hasSubmission: false })).toBe("in_progress");
  });

  it("is in_progress_overdue when a conversation exists, not submitted, due date passed", () => {
    expect(deriveSectionStatus({ dueDate: past, hasActiveConversation: true, hasSubmission: false })).toBe("in_progress_overdue");
  });

  it("is overdue when no conversation exists and due date passed", () => {
    expect(deriveSectionStatus({ dueDate: past, hasActiveConversation: false, hasSubmission: false })).toBe("overdue");
  });

  it("is not_started when no conversation exists and due date is in the future", () => {
    expect(deriveSectionStatus({ dueDate: future, hasActiveConversation: false, hasSubmission: false })).toBe("not_started");
  });
});

// Real-DB integration test, gated like Phase 1's real-DB suite (skips if
// DATABASE_URL isn't set locally; always runs in CI per turbo.json's
// declared env).
import { makeNodeDb } from "../../db/nodeClient";
import { unsafeCourseScope } from "./scope";
import { organizations, courses, courseMemberships, users, conversations } from "../../db/schema";
import { eq as eq2 } from "drizzle-orm";
import { createHomework, updateHomework, updateHomeworkPublishState, getHomeworkById } from "./homeworks";

describe.skipIf(!process.env.DATABASE_URL)("getStudentHomeworksForUser (real DB)", () => {
  it("only returns homeworks for courses the student is enrolled in, excludes drafts, ignores soft-deleted conversations", async () => {
    const db = makeNodeDb(process.env.DATABASE_URL!);
    const [org] = await db.insert(organizations).values({
      slug: `m3-test-9-${crypto.randomUUID()}`, name: "M3 Test Org 9", workosOrganizationId: `wo-9-${crypto.randomUUID()}`,
    }).returning();
    const [courseA] = await db.insert(courses).values({
      organizationId: org!.id, code: "TEST-A", term: "Test", title: "Course A",
    }).returning();
    const [courseB] = await db.insert(courses).values({
      organizationId: org!.id, code: "TEST-B", term: "Test", title: "Course B",
    }).returning();
    const [student] = await db.insert(users).values({
      email: crypto.getRandomValues(new Uint8Array(32)) as never,
      emailBlindIndex: crypto.getRandomValues(new Uint8Array(32)) as never,
    }).returning();
    const [instructorUser] = await db.insert(users).values({
      email: crypto.getRandomValues(new Uint8Array(32)) as never,
      emailBlindIndex: crypto.getRandomValues(new Uint8Array(32)) as never,
    }).returning();

    // Student enrolled in course A only -- course B is the "must NOT appear" control.
    await db.insert(courseMemberships).values({ userId: student!.id, courseId: courseA!.id, role: "student" });
    const [instructorMembershipA] = await db.insert(courseMemberships).values({
      userId: instructorUser!.id, courseId: courseA!.id, role: "instructor",
    }).returning();
    const [instructorMembershipB] = await db.insert(courseMemberships).values({
      userId: instructorUser!.id, courseId: courseB!.id, role: "instructor",
    }).returning();

    const scopeA = unsafeCourseScope(courseA!.id);
    const scopeB = unsafeCourseScope(courseB!.id);
    const hwA = await createHomework(db, scopeA, {
      createdById: instructorMembershipA!.id, title: "HW in Course A", description: "d", dueDate: new Date("2099-01-01"),
    });
    const hwB = await createHomework(db, scopeB, {
      createdById: instructorMembershipB!.id, title: "HW in Course B", description: "d", dueDate: new Date("2099-01-01"),
    });
    // Both published+active (publishedAt/releasedAt in the past, dueDate in the future).
    await updateHomeworkPublishState(db, scopeA, hwA!.id, { publish: true, releasedAt: new Date("2020-01-01") });
    await updateHomeworkPublishState(db, scopeB, hwB!.id, { publish: true, releasedAt: new Date("2020-01-01") });
    await updateHomework(db, scopeA, hwA!.id, {
      sections: [
        { title: "Sec 1", content: "c1", order: 1 },
        { title: "Sec 2", content: "c2", order: 2 },
      ],
    });
    await updateHomework(db, scopeB, hwB!.id, {
      sections: [{ title: "B Sec 1", content: "c1", order: 1 }],
    });

    const hwAWithSections = await getHomeworkById(db, scopeA, hwA!.id);
    const sec1 = hwAWithSections!.sections.find((s) => s.title === "Sec 1")!;

    // A soft-deleted conversation for the student on Sec 1 -- must not
    // count toward "in_progress" (getStudentHomeworksForUser only looks at
    // isDeleted=false conversations).
    await db.insert(conversations).values({
      ownerUserId: student!.id, courseId: courseA!.id, sectionId: sec1.id, kind: "section", title: "t",
      isDeleted: true, deletedAt: new Date(),
    });

    const result = await getStudentHomeworksForUser(db, student!.id);

    expect(result).toHaveLength(1);
    expect(result[0]!.title).toBe("HW in Course A");
    const sec1Status = result[0]!.sections.find((s) => s.title === "Sec 1")!;
    expect(sec1Status.status).toBe("not_started");

    await db.delete(organizations).where(eq2(organizations.id, org!.id));
  });
});
