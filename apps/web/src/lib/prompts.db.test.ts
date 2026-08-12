/* --------------------------------------------------------------------------
   resolvePromptTemplate / getPinnedPromptTemplateContent (#25), against a
   real Postgres. The thing under test is a multi-level scope-hierarchy
   query chain (section -> homework -> course -> org -> fallback) plus a
   partial-unique-style precedence rule (an override row must still be
   isActive) -- a mocked db would need to fake four separate query results
   in exactly the right order to be worth anything, and would still say
   nothing about the real FK/enum shapes. Skipped without DATABASE_URL,
   matching every other real-DB suite in this repo.
   -------------------------------------------------------------------------- */

import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { makeNodeDb } from "../db/nodeClient";
import type { Db } from "../db/client";
import { unsafeOrgScope, unsafeCourseScope } from "../server/repositories/scope";
import { resolvePromptTemplate, getPinnedPromptTemplateContent, DEFAULT_SYSTEM_PROMPT } from "./prompts";
import {
  organizations,
  courses,
  users,
  courseMemberships,
  homeworks,
  sections,
  promptTemplates,
} from "../db/schema";

const RAW_DATABASE_URL = process.env.DATABASE_URL;

function randomBytes(): never {
  return crypto.getRandomValues(new Uint8Array(16)) as never;
}

describe.skipIf(!RAW_DATABASE_URL)("resolvePromptTemplate (real DB, #25)", () => {
  let db: Db;

  beforeAll(async () => {
    db = makeNodeDb(RAW_DATABASE_URL!);
  });

  /** Fresh org/course/homework/section quadruple per test -- resolution
   *  precedence tests each add overrides/scoped templates incrementally, so
   *  shared fixtures across tests would make one test's setup leak into
   *  another's expectations. */
  async function seedCourse() {
    const [org] = await db
      .insert(organizations)
      .values({ name: "25-org", slug: `s25-${crypto.randomUUID().slice(0, 8)}`, workosOrganizationId: `org_${crypto.randomUUID().slice(0, 8)}` })
      .returning({ id: organizations.id });
    const [course] = await db
      .insert(courses)
      .values({ organizationId: org!.id, code: `C-${crypto.randomUUID().slice(0, 8)}`, term: "T", title: "t" })
      .returning({ id: courses.id });
    const [instructorUser] = await db
      .insert(users)
      .values({ email: randomBytes(), emailBlindIndex: randomBytes() })
      .returning({ id: users.id });
    const [instructorMembership] = await db
      .insert(courseMemberships)
      .values({ userId: instructorUser!.id, courseId: course!.id, role: "instructor" })
      .returning({ id: courseMemberships.id });
    const [hw] = await db
      .insert(homeworks)
      .values({
        courseId: course!.id,
        createdById: instructorMembership!.id,
        title: "hw",
        description: "d",
        dueDate: new Date(Date.now() + 86_400_000),
      })
      .returning({ id: homeworks.id });
    const [section] = await db
      .insert(sections)
      .values({ homeworkId: hw!.id, title: "s", content: "c", order: 1 })
      .returning({ id: sections.id });

    return {
      orgScope: unsafeOrgScope(org!.id),
      courseScope: unsafeCourseScope(course!.id),
      orgId: org!.id,
      courseId: course!.id,
      homeworkId: hw!.id,
      sectionId: section!.id,
    };
  }

  async function insertTemplate(scope: {
    scopeOrganizationId?: string;
    scopeCourseId?: string;
    scopeHomeworkId?: string;
    scopeSectionId?: string;
    content: string;
    isActive?: boolean;
  }) {
    const [row] = await db
      .insert(promptTemplates)
      .values({ version: 1, composeWithParent: false, isActive: true, ...scope })
      .returning({ id: promptTemplates.id });
    return row!.id;
  }

  it("falls back to DEFAULT_SYSTEM_PROMPT when no template exists at any scope", async () => {
    const ctx = await seedCourse();
    const resolved = await resolvePromptTemplate(db, ctx.orgScope, ctx.courseScope, ctx.sectionId);
    expect(resolved).toEqual({ id: null, content: DEFAULT_SYSTEM_PROMPT, version: null });
  });

  it("uses an org-scoped template when nothing more specific exists", async () => {
    const ctx = await seedCourse();
    const orgTemplateId = await insertTemplate({ scopeOrganizationId: ctx.orgId, content: "org-level prompt" });
    const resolved = await resolvePromptTemplate(db, ctx.orgScope, ctx.courseScope, ctx.sectionId);
    expect(resolved).toEqual({ id: orgTemplateId, content: "org-level prompt", version: 1 });
  });

  it("prefers a course-scoped template over an org-scoped one", async () => {
    const ctx = await seedCourse();
    await insertTemplate({ scopeOrganizationId: ctx.orgId, content: "org-level prompt" });
    const courseTemplateId = await insertTemplate({ scopeCourseId: ctx.courseId, content: "course-level prompt" });
    const resolved = await resolvePromptTemplate(db, ctx.orgScope, ctx.courseScope, ctx.sectionId);
    expect(resolved).toEqual({ id: courseTemplateId, content: "course-level prompt", version: 1 });
  });

  it("prefers the homework's direct override over a course-scoped template", async () => {
    const ctx = await seedCourse();
    await insertTemplate({ scopeCourseId: ctx.courseId, content: "course-level prompt" });
    const hwTemplateId = await insertTemplate({ scopeHomeworkId: ctx.homeworkId, content: "homework-level prompt" });
    await db.update(homeworks).set({ promptTemplateId: hwTemplateId }).where(eq(homeworks.id, ctx.homeworkId));

    const resolved = await resolvePromptTemplate(db, ctx.orgScope, ctx.courseScope, ctx.sectionId);
    expect(resolved).toEqual({ id: hwTemplateId, content: "homework-level prompt", version: 1 });
  });

  it("prefers the section's direct override over the homework's", async () => {
    const ctx = await seedCourse();
    const hwTemplateId = await insertTemplate({ scopeHomeworkId: ctx.homeworkId, content: "homework-level prompt" });
    await db.update(homeworks).set({ promptTemplateId: hwTemplateId }).where(eq(homeworks.id, ctx.homeworkId));
    const sectionTemplateId = await insertTemplate({ scopeSectionId: ctx.sectionId, content: "section-level prompt" });
    await db.update(sections).set({ promptTemplateId: sectionTemplateId }).where(eq(sections.id, ctx.sectionId));

    const resolved = await resolvePromptTemplate(db, ctx.orgScope, ctx.courseScope, ctx.sectionId);
    expect(resolved).toEqual({ id: sectionTemplateId, content: "section-level prompt", version: 1 });
  });

  it("falls through to the next scope level when an override row has been deactivated", async () => {
    const ctx = await seedCourse();
    const courseTemplateId = await insertTemplate({ scopeCourseId: ctx.courseId, content: "course-level prompt" });
    const sectionTemplateId = await insertTemplate({
      scopeSectionId: ctx.sectionId,
      content: "stale section prompt",
      isActive: false,
    });
    await db.update(sections).set({ promptTemplateId: sectionTemplateId }).where(eq(sections.id, ctx.sectionId));

    const resolved = await resolvePromptTemplate(db, ctx.orgScope, ctx.courseScope, ctx.sectionId);
    expect(resolved).toEqual({ id: courseTemplateId, content: "course-level prompt", version: 1 });
  });

  it("resolves to course/org scope only (no homework/section walk) when sectionId is null -- tutor-kind conversations", async () => {
    const ctx = await seedCourse();
    const hwTemplateId = await insertTemplate({ scopeHomeworkId: ctx.homeworkId, content: "homework-level prompt" });
    await db.update(homeworks).set({ promptTemplateId: hwTemplateId }).where(eq(homeworks.id, ctx.homeworkId));
    const courseTemplateId = await insertTemplate({ scopeCourseId: ctx.courseId, content: "course-level prompt" });

    const resolved = await resolvePromptTemplate(db, ctx.orgScope, ctx.courseScope, null);
    expect(resolved).toEqual({ id: courseTemplateId, content: "course-level prompt", version: 1 });
  });

  it("does not leak another org's org-scoped template", async () => {
    const ctxA = await seedCourse();
    const ctxB = await seedCourse();
    await insertTemplate({ scopeOrganizationId: ctxB.orgId, content: "org B's prompt" });

    const resolved = await resolvePromptTemplate(db, ctxA.orgScope, ctxA.courseScope, ctxA.sectionId);
    expect(resolved).toEqual({ id: null, content: DEFAULT_SYSTEM_PROMPT, version: null });
  });

  it("getPinnedPromptTemplateContent returns the exact pinned row's content even after it's deactivated", async () => {
    const ctx = await seedCourse();
    const pinnedId = await insertTemplate({ scopeCourseId: ctx.courseId, content: "v1 content, pinned" });
    // A newer version supersedes it -- deactivating v1 must NOT change what
    // an already-pinned conversation resolves to.
    await insertTemplate({ scopeCourseId: ctx.courseId, content: "v2 content" });
    await db.update(promptTemplates).set({ isActive: false }).where(eq(promptTemplates.id, pinnedId));

    const content = await getPinnedPromptTemplateContent(db, pinnedId);
    expect(content).toBe("v1 content, pinned");
  });

  it("getPinnedPromptTemplateContent returns null for a nonexistent id", async () => {
    const content = await getPinnedPromptTemplateContent(db, "00000000-0000-0000-0000-000000000000");
    expect(content).toBeNull();
  });
});
