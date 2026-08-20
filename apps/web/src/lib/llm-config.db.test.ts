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
import { resolveLLMConfig } from "./llm-config";
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
        name: opts.modelName ?? "some/model",
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

  // #317 review, #351 (requirement, "make the invariant structural"): a
  // brand-new org (no llm_configs row of any kind -- the exact state an
  // org onboarded post-deploy is in, since migration 0029 only ever
  // backfilled orgs that existed when it ran) used to throw
  // LLMConfigNotFoundError here. resolveLLMConfig now auto-provisions a
  // real, persisted default row instead, so a tenant is never dead on
  // arrival -- see ensurePlatformDefaultLLMConfig's own doc comment
  // (lib/llm-config.ts) for the full rationale.
  it("auto-provisions a real, persisted platform-default config when none exists at any scope (#351)", async () => {
    const ctx = await seedCourse();

    const resolved = await resolveLLMConfig(db, ctx.orgScope, ctx.courseScope, null);

    expect(resolved.provider).toBe("llmoxie");
    expect(resolved.modelName).toBe("gpt-5.3-codex");
    // A REAL row, not a synthetic in-memory value -- readable back by its
    // own id, scoped to this org, and now the org's active default.
    const [persisted] = await db.select().from(llmConfigs).where(eq(llmConfigs.id, resolved.id));
    expect(persisted).toBeDefined();
    expect(persisted!.organizationId).toBe(ctx.orgId);
    expect(persisted!.isDefault).toBe(true);
    expect(persisted!.isActive).toBe(true);
  });

  it("auto-provisions exactly once under real concurrency (two simultaneous first-resolutions for a brand-new org)", async () => {
    const ctx = await seedCourse();

    const results = await Promise.all(
      Array.from({ length: 5 }, () => resolveLLMConfig(db, ctx.orgScope, ctx.courseScope, null)),
    );

    // All five callers must land on the SAME row -- the partial unique
    // index (llm_configs_org_default_uq) is what makes that true, not
    // application-level locking.
    const ids = new Set(results.map((r) => r.id));
    expect(ids.size).toBe(1);

    const rows = await db.select().from(llmConfigs).where(eq(llmConfigs.organizationId, ctx.orgId));
    expect(rows).toHaveLength(1);
  });

  // resolveLLMConfig still refuses to serve an org whose is_default=true row
  // is merely inactive -- an admin's own deactivation must stay a real
  // error, not something the platform silently papers over by activating a
  // config nobody chose. As of the #317/#363 merge that branch is
  // defence-in-depth rather than a reachable path; see "an inactive default
  // is rejected by the database itself" below for why.

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

  it("an inactive default is rejected by the database itself (#317/#363 merge)", async () => {
    const ctx = await seedCourse();

    // This test used to construct an is_default=true, is_active=false row and
    // assert resolveLLMConfig threw LLMConfigNotFoundError rather than
    // serving it. #363's migration 0040 adds
    // llm_configs_active_required_for_default_chk -- CHECK (NOT (is_default
    // AND NOT is_active)) -- so that row is no longer a state the database
    // will hold at all, and the old setup fails on the INSERT instead of
    // reaching the resolver.
    //
    // Asserting the constraint rather than dropping it (agreed on #363): it
    // is the stronger of the two designs. The application half is
    // deactivateLlmConfigHandler (routes/llmConfigs.ts), which 409s with
    // "make another configuration the default first" instead of demoting a
    // default; this CHECK is what stops any other writer from reaching the
    // same state behind its back.
    await expect(insertConfig(ctx.orgId, { isDefault: true, isActive: false })).rejects.toThrow();

    // The resolver's own guard (ensurePlatformDefaultLLMConfig's re-select ->
    // LLMConfigNotFoundError) is deliberately left in place and is now
    // unreachable BY CONSTRUCTION: it fires only when the auto-provision
    // INSERT no-ops against an existing is_default row AND that row is
    // inactive, which is precisely the pair this constraint forbids. Not
    // exercised here on purpose -- reaching it would mean dropping the
    // constraint mid-run, and these .db.test.ts suites share one database
    // across parallel workers, so a table-wide DDL mutation would make
    // unrelated tests flaky. Deleting the branch instead would be worse: it
    // is the backstop for exactly the case where this constraint is ever
    // removed or a migration lands out of order.
  });

  it("resolves to the org default only (no homework or course override) when homeworkLlmConfigId is null -- tutor-kind conversations", async () => {
    const ctx = await seedCourse();
    const defaultId = await insertConfig(ctx.orgId, { isDefault: true, modelName: "org-default-model" });

    const resolved = await resolveLLMConfig(db, ctx.orgScope, ctx.courseScope, null);
    expect(resolved.id).toBe(defaultId);
  });

  // #317 review, #351: ctxA has no config of its own at any scope, so this
  // used to throw. It now auto-provisions -- the security property under
  // test (org B's config is never used for org A) still holds and is
  // asserted directly, just via "resolved to a fresh org-A row" instead of
  // "threw."
  it("does not honor a homeworkLlmConfigId belonging to another org (auto-provisions org A's own default instead)", async () => {
    const ctxA = await seedCourse();
    const ctxB = await seedCourse();
    const otherOrgConfigId = await insertConfig(ctxB.orgId, { modelName: "org-b-config" });

    const resolved = await resolveLLMConfig(db, ctxA.orgScope, ctxA.courseScope, otherOrgConfigId);

    expect(resolved.id).not.toBe(otherOrgConfigId);
    const [persisted] = await db.select().from(llmConfigs).where(eq(llmConfigs.id, resolved.id));
    expect(persisted!.organizationId).toBe(ctxA.orgId);
  });

  it("does not leak another org's default config (auto-provisions org A's own instead)", async () => {
    const ctxA = await seedCourse();
    const ctxB = await seedCourse();
    await insertConfig(ctxB.orgId, { isDefault: true, modelName: "org-b-default" });

    const resolved = await resolveLLMConfig(db, ctxA.orgScope, ctxA.courseScope, null);

    expect(resolved.modelName).not.toBe("org-b-default");
    const [persisted] = await db.select().from(llmConfigs).where(eq(llmConfigs.id, resolved.id));
    expect(persisted!.organizationId).toBe(ctxA.orgId);
  });
});
