/* --------------------------------------------------------------------------
   resolveLLMConfig (#26), against a real Postgres. Same rationale as
   prompts.db.test.ts: the thing under test is an org-scoped query chain
   (homework override -> course override -> org default -> not-found), and
   a mocked db would need to fake each step's result in exactly the right
   order to be worth anything. Skipped without DATABASE_URL, matching every
   other real-DB suite in this repo.

   #317 review, #326: resolveLLMConfig no longer reads `homeworks` itself --
   it takes the homework's llm_config_id value directly (the caller,
   chat.ts, already has it from getSectionPromptContext's own join, see
   lib/prompts.ts). These tests pass that value straight through instead of
   writing it onto a `homeworks` row and passing a homeworkId -- proving
   `homeworks.llm_config_id` actually flows into a real resolution is
   prompts.db.test.ts's job now (getSectionPromptContext's own coverage),
   not this function's.
   -------------------------------------------------------------------------- */

import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { makeNodeDb } from "../db/nodeClient";
import type { Db } from "../db/client";
import { unsafeOrgScope, unsafeCourseScope } from "../server/repositories/scope";
import { resolveLLMConfig, LLMConfigNotFoundError } from "./llm-config";
import { organizations, courses, llmConfigs } from "../db/schema";

const RAW_DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!RAW_DATABASE_URL)("resolveLLMConfig (real DB, #26)", () => {
  let db: Db;

  beforeAll(async () => {
    db = makeNodeDb(RAW_DATABASE_URL!);
  });

  async function seedCourse() {
    const [org] = await db
      .insert(organizations)
      .values({ name: "26-org", slug: `s26-${crypto.randomUUID().slice(0, 8)}`, workosOrganizationId: `org_${crypto.randomUUID().slice(0, 8)}` })
      .returning({ id: organizations.id });
    const [course] = await db
      .insert(courses)
      .values({ organizationId: org!.id, code: `C-${crypto.randomUUID().slice(0, 8)}`, term: "T", title: "t" })
      .returning({ id: courses.id });

    return {
      orgScope: unsafeOrgScope(org!.id),
      courseScope: unsafeCourseScope(course!.id),
      orgId: org!.id,
      courseId: course!.id,
    };
  }

  async function insertConfig(
    orgId: string,
    opts: Partial<{ isDefault: boolean; isActive: boolean; modelName: string; provider: "openrouter" | "llmoxie" }> = {},
  ) {
    const [row] = await db
      .insert(llmConfigs)
      .values({
        organizationId: orgId,
        provider: opts.provider ?? "openrouter",
        modelName: opts.modelName ?? "some/model",
        temperature: 0.7,
        maxCompletionTokens: 1000,
        isDefault: opts.isDefault ?? false,
        isActive: opts.isActive ?? true,
      })
      .returning({ id: llmConfigs.id });
    return row!.id;
  }

  it("throws LLMConfigNotFoundError with a referenceId when no config exists at any scope", async () => {
    const ctx = await seedCourse();
    await expect(resolveLLMConfig(db, ctx.orgScope, ctx.courseScope, null)).rejects.toBeInstanceOf(LLMConfigNotFoundError);
    try {
      await resolveLLMConfig(db, ctx.orgScope, ctx.courseScope, null);
      expect.unreachable();
    } catch (err) {
      expect((err as LLMConfigNotFoundError).referenceId).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("uses the org's default config when there is no homework or course override", async () => {
    const ctx = await seedCourse();
    const defaultId = await insertConfig(ctx.orgId, { isDefault: true, modelName: "org-default-model" });

    const resolved = await resolveLLMConfig(db, ctx.orgScope, ctx.courseScope, null);
    expect(resolved.id).toBe(defaultId);
    expect(resolved.modelName).toBe("org-default-model");
  });

  it("resolves a config whose provider is 'llmoxie' (#178 enum extension actually took)", async () => {
    const ctx = await seedCourse();
    const configId = await insertConfig(ctx.orgId, {
      isDefault: true,
      modelName: "gpt-4o-via-llmoxie",
      provider: "llmoxie",
    });

    const resolved = await resolveLLMConfig(db, ctx.orgScope, ctx.courseScope, null);
    expect(resolved.id).toBe(configId);
    expect(resolved.provider).toBe("llmoxie");
  });

  it("prefers the homework's own llm_config_id over the org default", async () => {
    const ctx = await seedCourse();
    await insertConfig(ctx.orgId, { isDefault: true, modelName: "org-default-model" });
    const overrideId = await insertConfig(ctx.orgId, { modelName: "homework-override-model" });

    const resolved = await resolveLLMConfig(db, ctx.orgScope, ctx.courseScope, overrideId);
    expect(resolved.id).toBe(overrideId);
    expect(resolved.modelName).toBe("homework-override-model");
  });

  it("prefers the course's own llm_config_id over the org default when there is no homework override (#325)", async () => {
    const ctx = await seedCourse();
    await insertConfig(ctx.orgId, { isDefault: true, modelName: "org-default-model" });
    const courseOverrideId = await insertConfig(ctx.orgId, { modelName: "course-override-model" });
    await db.update(courses).set({ llmConfigId: courseOverrideId }).where(eq(courses.id, ctx.courseId));

    const resolved = await resolveLLMConfig(db, ctx.orgScope, ctx.courseScope, null);
    expect(resolved.id).toBe(courseOverrideId);
    expect(resolved.modelName).toBe("course-override-model");
  });

  it("prefers the homework's own llm_config_id over the course's (#325)", async () => {
    const ctx = await seedCourse();
    const courseOverrideId = await insertConfig(ctx.orgId, { modelName: "course-override-model" });
    await db.update(courses).set({ llmConfigId: courseOverrideId }).where(eq(courses.id, ctx.courseId));
    const hwOverrideId = await insertConfig(ctx.orgId, { modelName: "homework-override-model" });

    const resolved = await resolveLLMConfig(db, ctx.orgScope, ctx.courseScope, hwOverrideId);
    expect(resolved.id).toBe(hwOverrideId);
    expect(resolved.modelName).toBe("homework-override-model");
  });

  it("falls through to the org default when the course's llm_config_id has been deactivated (#325)", async () => {
    const ctx = await seedCourse();
    const defaultId = await insertConfig(ctx.orgId, { isDefault: true, modelName: "org-default-model" });
    const courseOverrideId = await insertConfig(ctx.orgId, { modelName: "stale-course-override", isActive: false });
    await db.update(courses).set({ llmConfigId: courseOverrideId }).where(eq(courses.id, ctx.courseId));

    const resolved = await resolveLLMConfig(db, ctx.orgScope, ctx.courseScope, null);
    expect(resolved.id).toBe(defaultId);
  });

  it("resolves to the course override when homeworkLlmConfigId is null -- tutor-kind conversations (#325)", async () => {
    const ctx = await seedCourse();
    const courseOverrideId = await insertConfig(ctx.orgId, { modelName: "course-override-model" });
    await db.update(courses).set({ llmConfigId: courseOverrideId }).where(eq(courses.id, ctx.courseId));
    await insertConfig(ctx.orgId, { isDefault: true, modelName: "org-default-model" });

    const resolved = await resolveLLMConfig(db, ctx.orgScope, ctx.courseScope, null);
    expect(resolved.id).toBe(courseOverrideId);
  });

  it("falls through to the org default when the homework's override config has been deactivated", async () => {
    const ctx = await seedCourse();
    const defaultId = await insertConfig(ctx.orgId, { isDefault: true, modelName: "org-default-model" });
    const overrideId = await insertConfig(ctx.orgId, { modelName: "stale-override", isActive: false });

    const resolved = await resolveLLMConfig(db, ctx.orgScope, ctx.courseScope, overrideId);
    expect(resolved.id).toBe(defaultId);
  });

  it("throws when the only configs at any scope are inactive (does not silently use one anyway)", async () => {
    const ctx = await seedCourse();
    await insertConfig(ctx.orgId, { isDefault: true, isActive: false });

    await expect(resolveLLMConfig(db, ctx.orgScope, ctx.courseScope, null)).rejects.toBeInstanceOf(LLMConfigNotFoundError);
  });

  it("resolves to the org default only (no homework or course override) when homeworkLlmConfigId is null -- tutor-kind conversations", async () => {
    const ctx = await seedCourse();
    const defaultId = await insertConfig(ctx.orgId, { isDefault: true, modelName: "org-default-model" });

    const resolved = await resolveLLMConfig(db, ctx.orgScope, ctx.courseScope, null);
    expect(resolved.id).toBe(defaultId);
  });

  it("does not honor a homeworkLlmConfigId belonging to another org", async () => {
    const ctxA = await seedCourse();
    const ctxB = await seedCourse();
    const otherOrgConfigId = await insertConfig(ctxB.orgId, { modelName: "org-b-config" });

    await expect(
      resolveLLMConfig(db, ctxA.orgScope, ctxA.courseScope, otherOrgConfigId),
    ).rejects.toBeInstanceOf(LLMConfigNotFoundError);
  });

  it("does not leak another org's default config", async () => {
    const ctxA = await seedCourse();
    const ctxB = await seedCourse();
    await insertConfig(ctxB.orgId, { isDefault: true, modelName: "org-b-default" });

    await expect(resolveLLMConfig(db, ctxA.orgScope, ctxA.courseScope, null)).rejects.toBeInstanceOf(LLMConfigNotFoundError);
  });
});
