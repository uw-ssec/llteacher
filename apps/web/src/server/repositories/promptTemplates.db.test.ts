/* --------------------------------------------------------------------------
   upsertCourseScopedPromptTemplate / deactivateCourseScopedPromptTemplate
   (#317 review, #325), against a real Postgres. The thing under test is an
   atomic "deactivate old, insert new" write racing the scope_course_id
   partial unique index (#324) -- a mocked db would need to fake the
   constraint itself to be worth anything.
   -------------------------------------------------------------------------- */

import { describe, it, expect, beforeAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { makeNodeDb } from "../../db/nodeClient";
import type { Db } from "../../db/client";
import { unsafeCourseScope } from "./scope";
import {
  getCourseScopedPromptTemplate,
  upsertCourseScopedPromptTemplate,
  deactivateCourseScopedPromptTemplate,
} from "./promptTemplates";
import { PromptTemplateConflictError } from "./errors";
import { organizations, courses, promptTemplates } from "../../db/schema";

const RAW_DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!RAW_DATABASE_URL)("course-scoped prompt_templates writers (real DB, #325)", () => {
  let db: Db;

  beforeAll(async () => {
    db = makeNodeDb(RAW_DATABASE_URL!);
  });

  async function seedCourse() {
    const [org] = await db
      .insert(organizations)
      .values({ name: "325-org", slug: `s325-${crypto.randomUUID().slice(0, 8)}`, workosOrganizationId: `org_${crypto.randomUUID().slice(0, 8)}` })
      .returning({ id: organizations.id });
    const [course] = await db
      .insert(courses)
      .values({ organizationId: org!.id, code: `C-${crypto.randomUUID().slice(0, 8)}`, term: "T", title: "t" })
      .returning({ id: courses.id });
    return { courseScope: unsafeCourseScope(course!.id) };
  }

  it("creates the course's first scoped template at version 1", async () => {
    const ctx = await seedCourse();
    const result = await upsertCourseScopedPromptTemplate(db, ctx.courseScope, {
      content: "v1 content",
      composeWithParent: false,
    });
    expect(result.version).toBe(1);

    const row = await getCourseScopedPromptTemplate(db, ctx.courseScope);
    expect(row).toMatchObject({ id: result.id, content: "v1 content", version: 1, composeWithParent: false });
  });

  it("version-bumps and deactivates the prior row atomically, without violating the partial unique index", async () => {
    const ctx = await seedCourse();
    const v1 = await upsertCourseScopedPromptTemplate(db, ctx.courseScope, {
      content: "v1 content",
      composeWithParent: false,
    });
    const v2 = await upsertCourseScopedPromptTemplate(db, ctx.courseScope, {
      content: "v2 content",
      composeWithParent: true,
    });
    expect(v2.version).toBe(2);
    expect(v2.id).not.toBe(v1.id);

    const current = await getCourseScopedPromptTemplate(db, ctx.courseScope);
    expect(current).toMatchObject({ id: v2.id, content: "v2 content", version: 2, composeWithParent: true });

    const [oldRow] = await db.select().from(promptTemplates).where(eq(promptTemplates.id, v1.id));
    expect(oldRow?.isActive).toBe(false);

    const [newRow] = await db.select().from(promptTemplates).where(eq(promptTemplates.id, v2.id));
    expect(newRow?.previousVersionId).toBe(v1.id);
  });

  it("deactivateCourseScopedPromptTemplate reverts resolution to nothing at the course scope", async () => {
    const ctx = await seedCourse();
    await upsertCourseScopedPromptTemplate(db, ctx.courseScope, { content: "v1", composeWithParent: false });

    await deactivateCourseScopedPromptTemplate(db, ctx.courseScope);

    expect(await getCourseScopedPromptTemplate(db, ctx.courseScope)).toBeNull();
    const activeRows = await db
      .select()
      .from(promptTemplates)
      .where(and(eq(promptTemplates.scopeCourseId, ctx.courseScope), eq(promptTemplates.isActive, true)));
    expect(activeRows).toHaveLength(0);
  });

  it("deactivateCourseScopedPromptTemplate is a no-op when nothing is active", async () => {
    const ctx = await seedCourse();
    await expect(deactivateCourseScopedPromptTemplate(db, ctx.courseScope)).resolves.toBeUndefined();
  });

  it("does not leak another course's scoped template", async () => {
    const ctxA = await seedCourse();
    const ctxB = await seedCourse();
    await upsertCourseScopedPromptTemplate(db, ctxB.courseScope, { content: "course B", composeWithParent: false });

    expect(await getCourseScopedPromptTemplate(db, ctxA.courseScope)).toBeNull();
  });

  // #317 review, code-review follow-up: upsertCourseScopedPromptTemplate
  // reads `current` then writes with no row lock between the two -- two
  // concurrent callers racing the same course (a double-click, two tabs)
  // can both read the same `current` and both attempt to insert a
  // conflicting active row; prompt_templates_scope_course_active_uq lets
  // only one through per genuine collision. 10 writers (not 2) because a
  // real connection pool doesn't guarantee any given pair's read-then-write
  // windows actually overlap -- some of these may legitimately serialize
  // into a normal version-bump chain rather than collide, which is correct
  // behavior, not a test failure. What must hold regardless of how many
  // happen to collide: every rejection is PromptTemplateConflictError
  // (never a raw, unhandled constraint-violation exception), and the
  // course ends up with exactly one active row, never zero or more than one.
  it("translates a concurrent-write race into PromptTemplateConflictError, not an unhandled exception, and never corrupts state", async () => {
    const ctx = await seedCourse();
    const WRITER_COUNT = 10;

    const results = await Promise.allSettled(
      Array.from({ length: WRITER_COUNT }, (_, i) =>
        upsertCourseScopedPromptTemplate(db, ctx.courseScope, { content: `writer ${i}`, composeWithParent: false }),
      ),
    );

    const fulfilled = results.filter((r): r is PromiseFulfilledResult<{ id: string; version: number }> => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled.length).toBeGreaterThan(0);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(PromptTemplateConflictError);
    }

    const activeRows = await db
      .select()
      .from(promptTemplates)
      .where(and(eq(promptTemplates.scopeCourseId, ctx.courseScope), eq(promptTemplates.isActive, true)));
    expect(activeRows).toHaveLength(1);
  });
});
