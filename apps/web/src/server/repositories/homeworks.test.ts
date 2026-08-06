import { describe, it, expect, vi } from "vitest";
import {
  listHomeworksForCourse,
  createHomework,
  getHomeworkById,
  updateHomework,
  deriveHomeworkStatus,
  homeworkHasStudentActivity,
} from "./homeworks";
import { unsafeCourseScope } from "./scope";
import type { Db } from "../../db/client";

// listHomeworksForCourse's section-count query is `db.select({...}).from
// (sections).where(...).groupBy(...)` -- a plain builder chain, not a
// db.query.*.findMany call, so it needs its own fake chain distinct from
// the findMany mock used for the homeworks fetch itself.
function mockSectionCountsChain(counts: { homeworkId: string; count: number }[]) {
  const groupBy = vi.fn().mockResolvedValue(counts);
  const where = vi.fn().mockReturnValue({ groupBy });
  const from = vi.fn().mockReturnValue({ where });
  return vi.fn().mockReturnValue({ from });
}

describe("homeworks repository", () => {
  it("listHomeworksForCourse shapes rows via deriveHomeworkStatus and attaches section counts", async () => {
    const hwRow = {
      id: "hw1",
      title: "HW 1",
      description: "d",
      dueDate: new Date("2020-01-02"),
      llmConfigId: null,
      publishedAt: new Date("2020-01-01"),
      releasedAt: new Date("2020-01-01"),
    };
    const findMany = vi.fn().mockResolvedValue([hwRow]);
    const select = mockSectionCountsChain([{ homeworkId: "hw1", count: 3 }]);
    const db = { query: { homeworks: { findMany } }, select } as unknown as Db;

    const result = await listHomeworksForCourse(db, unsafeCourseScope("course-a"));

    expect(result).toEqual([
      {
        id: "hw1",
        title: "HW 1",
        description: "d",
        dueDate: hwRow.dueDate.toISOString(),
        llmConfigId: null,
        status: "past_due",
        sectionCount: 3,
      },
    ]);
    expect(findMany).toHaveBeenCalledOnce();
  });

  it("returns sectionCount: 0 for a homework the count query has no row for (not the outer list being empty)", async () => {
    const hwRow = {
      id: "hw2",
      title: "HW 2",
      description: "d",
      dueDate: new Date("2099-01-01"),
      llmConfigId: null,
      publishedAt: null,
      releasedAt: null,
    };
    const findMany = vi.fn().mockResolvedValue([hwRow]);
    // The count query itself returns zero rows for hw2 (no sections exist),
    // distinct from the rows.length === 0 early-return below.
    const select = mockSectionCountsChain([]);
    const db = { query: { homeworks: { findMany } }, select } as unknown as Db;

    const result = await listHomeworksForCourse(db, unsafeCourseScope("course-a"));

    expect(result).toEqual([
      {
        id: "hw2",
        title: "HW 2",
        description: "d",
        dueDate: hwRow.dueDate.toISOString(),
        llmConfigId: null,
        status: "draft",
        sectionCount: 0,
      },
    ]);
  });

  it("returns [] without querying section counts when the course has no homeworks", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const select = vi.fn();
    const db = { query: { homeworks: { findMany } }, select } as unknown as Db;

    const result = await listHomeworksForCourse(db, unsafeCourseScope("course-a"));

    expect(result).toEqual([]);
    expect(select).not.toHaveBeenCalled();
  });

  // Finding 2 (Phase 7 final review): with no explicit orderBy, Postgres
  // heap-scan order can change after any UPDATE, silently reordering the
  // catalog and renumbering the HW-00N badges apps/admin derives from array
  // position. This fake findMany actually applies the `orderBy` callback
  // listHomeworksForCourse passes (rather than ignoring it, as a plain
  // mockResolvedValue would) so this test exercises the real sort
  // direction/key, not just that some orderBy option was passed.
  it("orders homeworks by createdAt ascending regardless of insertion/mock order", async () => {
    const baseRow = { description: "d", dueDate: new Date("2099-01-01"), llmConfigId: null, publishedAt: null, releasedAt: null };
    const rows = [
      { ...baseRow, id: "hw-b", title: "B", createdAt: new Date("2020-01-02") },
      { ...baseRow, id: "hw-a", title: "A", createdAt: new Date("2020-01-01") },
      { ...baseRow, id: "hw-c", title: "C", createdAt: new Date("2020-01-03") },
    ];
    type Order = { field: string; dir: string };
    const findMany = vi.fn().mockImplementation(
      async (opts: { orderBy?: (h: Record<string, string>, helpers: { asc: (f: string) => Order }) => Order[] }) => {
        const h = new Proxy({}, { get: (_t, prop) => prop }) as Record<string, string>;
        const asc = (field: string): Order => ({ field, dir: "asc" });
        const [order] = opts.orderBy ? opts.orderBy(h, { asc }) : [];
        if (!order) return rows;
        return [...rows].sort((a, b) => {
          const av = (a as unknown as Record<string, Date>)[order.field].getTime();
          const bv = (b as unknown as Record<string, Date>)[order.field].getTime();
          return order.dir === "asc" ? av - bv : bv - av;
        });
      },
    );
    const select = mockSectionCountsChain([]);
    const db = { query: { homeworks: { findMany } }, select } as unknown as Db;

    const result = await listHomeworksForCourse(db, unsafeCourseScope("course-a"));

    expect(result.map((r) => r.id)).toEqual(["hw-a", "hw-b", "hw-c"]);
  });

  it("createHomework inserts with the scope as courseId", async () => {
    const returning = vi.fn().mockResolvedValue([{ id: "hw-new" }]);
    const values = vi.fn().mockReturnValue({ returning });
    const insert = vi.fn().mockReturnValue({ values });
    const db = { insert } as unknown as Db;

    const result = await createHomework(db, unsafeCourseScope("course-a"), {
      createdById: "membership-1",
      title: "New HW",
      description: "desc",
      dueDate: new Date("2026-12-01"),
    });

    expect(result).toEqual({ id: "hw-new" });
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ courseId: "course-a", createdById: "membership-1", title: "New HW" }),
    );
  });
});

describe("deriveHomeworkStatus", () => {
  const base = { dueDate: new Date("2026-09-01T00:00:00Z") };

  it("is draft when publishedAt is null", () => {
    expect(deriveHomeworkStatus({ ...base, publishedAt: null, releasedAt: null })).toBe("draft");
  });

  it("is scheduled when releasedAt is in the future", () => {
    expect(
      deriveHomeworkStatus({
        ...base,
        publishedAt: new Date("2026-08-01T00:00:00Z"),
        releasedAt: new Date("2099-01-01T00:00:00Z"),
      }),
    ).toBe("scheduled");
  });

  it("is active when released and due date is in the future", () => {
    expect(
      deriveHomeworkStatus({
        dueDate: new Date("2099-01-01T00:00:00Z"),
        publishedAt: new Date("2026-08-01T00:00:00Z"),
        releasedAt: new Date("2026-08-01T00:00:00Z"),
      }),
    ).toBe("active");
  });

  it("is past_due when released and due date has passed", () => {
    expect(
      deriveHomeworkStatus({
        dueDate: new Date("2020-01-01T00:00:00Z"),
        publishedAt: new Date("2019-01-01T00:00:00Z"),
        releasedAt: new Date("2019-01-01T00:00:00Z"),
      }),
    ).toBe("past_due");
  });

  // "archived" is intentionally not reachable from any input this function
  // accepts -- no feature in this milestone produces it. See the comment on
  // deriveHomeworkStatus itself. Not tested here because there is no valid
  // input that should ever produce it; a test asserting "no input reaches
  // this branch" would just restate the function.
});

// Real-DB integration tests, gated like M2's real-DB suites (skips if
// DATABASE_URL isn't set locally; always runs in CI per turbo.json's
// declared env).
import { makeNodeDb } from "../../db/nodeClient";
import { organizations, courses, courseMemberships, users, conversations } from "../../db/schema";
import { eq as eq2 } from "drizzle-orm";

// Fixed byte arrays would collide with users_email_blind_index_uq across
// runs (the users table isn't cascade-deleted when a test's organizations
// row is cleaned up) -- random bytes per call, matching every other
// real-DB test file's convention (conversations.test.ts, submissions.test.ts).
// The suffix passed in also gets a crypto.randomUUID() appended (beyond the
// brief's plain "1"/"2"/... suffixes) so slug/workosOrganizationId stay
// unique across repeated local runs of this file too, not just within one.
async function seedCourseWithInstructor(db: ReturnType<typeof makeNodeDb>, suffix: string) {
  const [org] = await db.insert(organizations).values({
    slug: `m3-test-${suffix}`, name: `M3 Test Org ${suffix}`, workosOrganizationId: `wo-${suffix}`,
  }).returning();
  const [course] = await db.insert(courses).values({
    organizationId: org!.id, code: `TEST-${suffix}`, term: "Test", title: `Test Course ${suffix}`,
  }).returning();
  const [user] = await db.insert(users).values({
    email: crypto.getRandomValues(new Uint8Array(32)) as never,
    emailBlindIndex: crypto.getRandomValues(new Uint8Array(32)) as never,
  }).returning();
  const [membership] = await db.insert(courseMemberships).values({
    userId: user!.id, courseId: course!.id, role: "instructor",
  }).returning();
  return { org: org!, course: course!, membership: membership! };
}

describe.skipIf(!process.env.DATABASE_URL)("updateHomework (real DB)", () => {
  it("creates, updates, reorders, and deletes sections in one call; solution lifecycle round-trips", async () => {
    const db = makeNodeDb(process.env.DATABASE_URL!);
    const { org, membership } = await seedCourseWithInstructor(db, `1-${crypto.randomUUID()}`);
    const scope = unsafeCourseScope(membership.courseId);
    const created = await createHomework(db, scope, {
      createdById: membership.id, title: "HW1", description: "d", dueDate: new Date("2099-01-01"),
    });

    const initial = await updateHomework(db, scope, created!.id, {
      sections: [
        { title: "Sec A", content: "a", order: 1 },
        { title: "Sec B", content: "b", order: 2, solutionContent: "sol-b" },
      ],
    });
    expect(initial).not.toBeNull();

    const afterCreate = await getHomeworkById(db, scope, created!.id);
    const secA = afterCreate!.sections.find((s) => s.title === "Sec A")!;
    const secB = afterCreate!.sections.find((s) => s.title === "Sec B")!;
    expect(secB.solution?.content).toBe("sol-b");

    // Diff pass: update Sec A's title, reorder (A<->B, a genuine 2-cycle --
    // exercises the scratch-bump path), remove Sec B's solution, add a
    // brand-new Sec C, delete nothing.
    await updateHomework(db, scope, created!.id, {
      sections: [
        { id: secA.id, title: "Sec A revised", content: "a", order: 2 },
        { id: secB.id, title: "Sec B", content: "b", order: 1 },
        { title: "Sec C", content: "c", order: 3 },
      ],
    });

    const afterDiff = await getHomeworkById(db, scope, created!.id);
    expect(afterDiff!.sections.map((s) => s.title)).toEqual(["Sec B", "Sec A revised", "Sec C"]);
    expect(afterDiff!.sections.find((s) => s.title === "Sec B")!.solution).toBeNull();

    // Final diff: omit Sec C -> deleted.
    await updateHomework(db, scope, created!.id, {
      sections: [
        { id: secA.id, title: "Sec A revised", content: "a", order: 1 },
        { id: secB.id, title: "Sec B", content: "b", order: 2 },
      ],
    });
    const afterDelete = await getHomeworkById(db, scope, created!.id);
    expect(afterDelete!.sections).toHaveLength(2);

    await db.delete(organizations).where(eq2(organizations.id, org.id));
  });

  it("rejects a diff with a duplicate order and leaves existing sections untouched", async () => {
    const db = makeNodeDb(process.env.DATABASE_URL!);
    const { org, membership } = await seedCourseWithInstructor(db, `2-${crypto.randomUUID()}`);
    const scope = unsafeCourseScope(membership.courseId);
    const created = await createHomework(db, scope, {
      createdById: membership.id, title: "HW2", description: "d", dueDate: new Date("2099-01-01"),
    });
    await updateHomework(db, scope, created!.id, {
      sections: [{ title: "Sec A", content: "a", order: 1 }],
    });

    await expect(
      updateHomework(db, scope, created!.id, {
        sections: [
          { title: "X", content: "x", order: 1 },
          { title: "Y", content: "y", order: 1 },
        ],
      }),
    ).rejects.toThrow(/duplicate order/i);

    const afterFailedDiff = await getHomeworkById(db, scope, created!.id);
    expect(afterFailedDiff!.sections).toHaveLength(1); // untouched

    await db.delete(organizations).where(eq2(organizations.id, org.id));
  });

  it("shifts a range with zero scratch bumps when a section is inserted in the middle", async () => {
    // Inserting at position 2 of an existing 1/2/3 shifts 2->3 and 3->4 --
    // a range shift, not a cycle. Verifies resolveSectionWrites resolves
    // this purely through pass-based ordering (see Resolved Design
    // Decision 7): the section that vacates a slot first is whichever one
    // this diff didn't block on anything else, discovered automatically by
    // the algorithm rather than by the test asserting a specific statement
    // order.
    const db = makeNodeDb(process.env.DATABASE_URL!);
    const { org, membership } = await seedCourseWithInstructor(db, `3-${crypto.randomUUID()}`);
    const scope = unsafeCourseScope(membership.courseId);
    const created = await createHomework(db, scope, {
      createdById: membership.id, title: "HW3", description: "d", dueDate: new Date("2099-01-01"),
    });
    await updateHomework(db, scope, created!.id, {
      sections: [
        { title: "S1", content: "1", order: 1 },
        { title: "S2", content: "2", order: 2 },
        { title: "S3", content: "3", order: 3 },
      ],
    });
    const before = await getHomeworkById(db, scope, created!.id);
    const s1 = before!.sections.find((s) => s.title === "S1")!;
    const s2 = before!.sections.find((s) => s.title === "S2")!;
    const s3 = before!.sections.find((s) => s.title === "S3")!;

    await updateHomework(db, scope, created!.id, {
      sections: [
        { id: s1.id, title: "S1", content: "1", order: 1 },
        { title: "NEW", content: "new", order: 2 },
        { id: s2.id, title: "S2", content: "2", order: 3 },
        { id: s3.id, title: "S3", content: "3", order: 4 },
      ],
    });

    const after = await getHomeworkById(db, scope, created!.id);
    expect(after!.sections.map((s) => [s.title, s.order])).toEqual([
      ["S1", 1], ["NEW", 2], ["S2", 3], ["S3", 4],
    ]);

    await db.delete(organizations).where(eq2(organizations.id, org.id));
  });

  it("resolves a genuine 3-way reorder cycle via a scratch bump", async () => {
    // A(1)->2, B(2)->3, C(3)->1 -- every target is held by another section
    // in the same cycle, so a direct pass-based resolution alone cannot
    // place any of them; this exercises the scratch-bump branch (with only
    // 3 sections, slot 4+ is available as scratch).
    const db = makeNodeDb(process.env.DATABASE_URL!);
    const { org, membership } = await seedCourseWithInstructor(db, `4-${crypto.randomUUID()}`);
    const scope = unsafeCourseScope(membership.courseId);
    const created = await createHomework(db, scope, {
      createdById: membership.id, title: "HW4", description: "d", dueDate: new Date("2099-01-01"),
    });
    await updateHomework(db, scope, created!.id, {
      sections: [
        { title: "A", content: "a", order: 1 },
        { title: "B", content: "b", order: 2 },
        { title: "C", content: "c", order: 3 },
      ],
    });
    const before = await getHomeworkById(db, scope, created!.id);
    const a = before!.sections.find((s) => s.title === "A")!;
    const b = before!.sections.find((s) => s.title === "B")!;
    const c = before!.sections.find((s) => s.title === "C")!;

    await updateHomework(db, scope, created!.id, {
      sections: [
        { id: a.id, title: "A", content: "a", order: 2 },
        { id: b.id, title: "B", content: "b", order: 3 },
        { id: c.id, title: "C", content: "c", order: 1 },
      ],
    });

    const after = await getHomeworkById(db, scope, created!.id);
    expect(after!.sections.map((s) => [s.title, s.order]).sort()).toEqual([
      ["A", 2], ["B", 3], ["C", 1],
    ].sort());

    await db.delete(organizations).where(eq2(organizations.id, org.id));
  });

  it("returns a friendly error when all 20 sections are reordered in a single full cyclic rotation", async () => {
    // The one case resolveSectionWrites cannot resolve: every order slot
    // 1-20 is simultaneously occupied AND every section is moving, so no
    // scratch value exists anywhere in the allowed range.
    const db = makeNodeDb(process.env.DATABASE_URL!);
    const { org, membership } = await seedCourseWithInstructor(db, `5-${crypto.randomUUID()}`);
    const scope = unsafeCourseScope(membership.courseId);
    const created = await createHomework(db, scope, {
      createdById: membership.id, title: "HW5", description: "d", dueDate: new Date("2099-01-01"),
    });
    const initialSections = Array.from({ length: 20 }, (_, i) => ({
      title: `Sec ${i + 1}`, content: `c${i + 1}`, order: i + 1,
    }));
    await updateHomework(db, scope, created!.id, { sections: initialSections });
    const before = await getHomeworkById(db, scope, created!.id);
    const byTitle = new Map(before!.sections.map((s) => [s.title, s]));

    // Full rotation: section at order N moves to order (N % 20) + 1.
    const rotated = initialSections.map((s) => ({
      id: byTitle.get(s.title)!.id, title: s.title, content: s.content,
      order: (s.order % 20) + 1,
    }));

    await expect(
      updateHomework(db, scope, created!.id, { sections: rotated }),
    ).rejects.toThrow(/no free order slot/i);

    await db.delete(organizations).where(eq2(organizations.id, org.id));
  });
});

describe.skipIf(!process.env.DATABASE_URL)("homeworkHasStudentActivity (real DB)", () => {
  it("is false with no conversations against any section, true once one is created", async () => {
    const db = makeNodeDb(process.env.DATABASE_URL!);
    const { org, membership } = await seedCourseWithInstructor(db, `6-${crypto.randomUUID()}`);
    const scope = unsafeCourseScope(membership.courseId);
    const created = await createHomework(db, scope, {
      createdById: membership.id, title: "HW6", description: "d", dueDate: new Date("2099-01-01"),
    });
    await updateHomework(db, scope, created!.id, {
      sections: [{ title: "Sec A", content: "a", order: 1 }],
    });
    const withSections = await getHomeworkById(db, scope, created!.id);
    const section = withSections!.sections[0]!;

    expect(await homeworkHasStudentActivity(db, created!.id)).toBe(false);

    await db.insert(conversations).values({
      ownerUserId: membership.userId,
      courseId: membership.courseId,
      sectionId: section.id,
      kind: "section",
      title: "t",
    });

    expect(await homeworkHasStudentActivity(db, created!.id)).toBe(true);

    await db.delete(organizations).where(eq2(organizations.id, org.id));
  });
});
