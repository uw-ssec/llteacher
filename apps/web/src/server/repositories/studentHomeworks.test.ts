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
import { organizations, courses, courseMemberships, users, conversations, submissions } from "../../db/schema";
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

  // #158: query count must not grow with the number of homeworks/sections.
  it("uses a fixed number of db query round-trips regardless of section count", async () => {
    const db = makeNodeDb(process.env.DATABASE_URL!);
    const [org] = await db.insert(organizations).values({
      slug: `m3-test-158-${crypto.randomUUID()}`, name: "M3 Test Org 158", workosOrganizationId: `wo-158-${crypto.randomUUID()}`,
    }).returning();
    const [course] = await db.insert(courses).values({
      organizationId: org!.id, code: "TEST-158", term: "Test", title: "Course 158",
    }).returning();
    const [student] = await db.insert(users).values({
      email: crypto.getRandomValues(new Uint8Array(32)) as never,
      emailBlindIndex: crypto.getRandomValues(new Uint8Array(32)) as never,
    }).returning();
    const [instructorUser] = await db.insert(users).values({
      email: crypto.getRandomValues(new Uint8Array(32)) as never,
      emailBlindIndex: crypto.getRandomValues(new Uint8Array(32)) as never,
    }).returning();
    await db.insert(courseMemberships).values({ userId: student!.id, courseId: course!.id, role: "student" });
    const [instructorMembership] = await db.insert(courseMemberships).values({
      userId: instructorUser!.id, courseId: course!.id, role: "instructor",
    }).returning();

    const scope = unsafeCourseScope(course!.id);
    // Three published homeworks with several sections each -- if the fix
    // regressed to the old per-section loop, the query count below would
    // scale with this number instead of staying constant.
    let firstSectionId: string | undefined;
    for (let i = 0; i < 3; i++) {
      const hw = await createHomework(db, scope, {
        createdById: instructorMembership!.id, title: `HW ${i}`, description: "d", dueDate: new Date("2099-01-01"),
      });
      await updateHomeworkPublishState(db, scope, hw!.id, { publish: true, releasedAt: new Date("2020-01-01") });
      await updateHomework(db, scope, hw!.id, {
        sections: [
          { title: "Sec 1", content: "c1", order: 1 },
          { title: "Sec 2", content: "c2", order: 2 },
          { title: "Sec 3", content: "c3", order: 3 },
        ],
      });
      if (i === 0) {
        const withSections = await getHomeworkById(db, scope, hw!.id);
        firstSectionId = withSections!.sections[0]!.id;
      }
    }

    // A conversation (with a submission) on one section -- ensures both
    // batched selects (conversations, submissions) actually execute, so
    // this test can't pass vacuously by short-circuiting on an empty
    // conversationIds array.
    const [convo] = await db.insert(conversations).values({
      ownerUserId: student!.id, courseId: course!.id, sectionId: firstSectionId!, kind: "section", title: "t",
    }).returning();
    await db.insert(submissions).values({ conversationId: convo!.id, organizationId: org!.id });

    // Same wrap-and-count technique as submissions.test.ts's "no N+1" test:
    // db.query.*.findMany are Drizzle's relational query builder, db.select
    // is the plain query builder -- getStudentHomeworksForUser calls
    // db.query.courseMemberships.findMany once, db.query.homeworks.findMany
    // once, and db.select() twice (conversations, submissions) = 4 total,
    // fixed regardless of how many homeworks/sections exist above.
    let queryCount = 0;
    const targets: Array<[object, string]> = [
      [db.query.courseMemberships, "findMany"],
      [db.query.homeworks, "findMany"],
    ];
    const originals = targets.map(([obj, key]) => (obj as Record<string, unknown>)[key]);
    const originalSelect = db.select.bind(db);
    targets.forEach(([obj, key], i) => {
      (obj as Record<string, unknown>)[key] = (...args: unknown[]) => {
        queryCount++;
        return (originals[i] as (...a: unknown[]) => unknown).apply(obj, args);
      };
    });
    (db as unknown as Record<string, unknown>).select = (...args: unknown[]) => {
      queryCount++;
      return (originalSelect as (...a: unknown[]) => unknown)(...args);
    };
    try {
      const result = await getStudentHomeworksForUser(db, student!.id);
      expect(result).toHaveLength(3);
    } finally {
      targets.forEach(([obj, key], i) => { (obj as Record<string, unknown>)[key] = originals[i]; });
      (db as unknown as Record<string, unknown>).select = originalSelect;
    }
    expect(queryCount).toBe(4);

    await db.delete(organizations).where(eq2(organizations.id, org!.id));
  });
});
