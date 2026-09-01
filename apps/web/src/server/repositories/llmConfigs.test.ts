import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { makeNodeDb } from "../../db/nodeClient";
import type { Db } from "../../db/client";
import {
  courseMemberships,
  courses,
  homeworks,
  llmConfigs,
  organizations,
  sections,
  users,
} from "../../db/schema";
import { unsafeOrgScope } from "./scope";
import {
  cloneLlmConfig,
  createLlmConfig,
  deactivateLlmConfig,
  getDefaultLlmConfig,
  getLlmConfig,
  listLlmConfigsForOrg,
  llmConfigBelongsToOrg,
  resolveLlmConfig,
  updateLlmConfig,
  type LlmConfigInput,
} from "./llmConfigs";
// #364: the failover hop moved out of this repository (see the note where
// `resolveFallbackConfig` used to be) -- these tests moved with it rather
// than being deleted, since what they pin is a database behaviour, not a
// module boundary.
import { resolveFallbackLLMConfig } from "../../lib/llm-config";

const DATABASE_URL = process.env.DATABASE_URL;

// #149: listLlmConfigsForOrg/getDefaultLlmConfig had zero test coverage
// despite the Phase-4 commit claiming cross-org isolation tests for every
// repository it added. That note used to end "no production route calls
// either function yet" -- #31's CRUD routes now call listLlmConfigsForOrg,
// and #170's resolveLlmConfig supersedes getDefaultLlmConfig for the
// resolution path (it applies the same isDefault filter plus the isActive
// one and the homework tier above it).
describe.skipIf(!DATABASE_URL)("llmConfigs repository", () => {
  let db: Db;
  let orgAId: string;
  let orgBId: string;
  let configAId: string;
  let configBDefaultId: string;
  let configBNonDefaultId: string;

  beforeAll(async () => {
    db = makeNodeDb(DATABASE_URL!);
    const [orgA] = await db
      .insert(organizations)
      .values({ slug: `llmcfg-a-${crypto.randomUUID()}`, name: "A", workosOrganizationId: `w-a-${crypto.randomUUID()}` })
      .returning({ id: organizations.id });
    orgAId = orgA.id;
    const [orgB] = await db
      .insert(organizations)
      .values({ slug: `llmcfg-b-${crypto.randomUUID()}`, name: "B", workosOrganizationId: `w-b-${crypto.randomUUID()}` })
      .returning({ id: organizations.id });
    orgBId = orgB.id;

    const [configA] = await db
      .insert(llmConfigs)
      .values({ organizationId: orgAId, name: "A default", provider: "anthropic", modelName: "claude-sonnet", isDefault: true })
      .returning({ id: llmConfigs.id });
    configAId = configA.id;

    const [configBDefault] = await db
      .insert(llmConfigs)
      .values({ organizationId: orgBId, name: "B default", provider: "openai", modelName: "gpt-5", isDefault: true })
      .returning({ id: llmConfigs.id });
    configBDefaultId = configBDefault.id;
    const [configBNonDefault] = await db
      .insert(llmConfigs)
      .values({ organizationId: orgBId, name: "B free tier", provider: "openrouter", modelName: "free-tier", isDefault: false })
      .returning({ id: llmConfigs.id });
    configBNonDefaultId = configBNonDefault.id;
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgAId));
    await db.delete(organizations).where(eq(organizations.id, orgBId));
  });

  // Mutation-check: asserts the exact id set for org B (both configs,
  // neither belonging to org A), not just "list is non-empty" -- if
  // listLlmConfigsForOrg's organizationId filter were ever dropped, this
  // would return configAId too and fail.
  it("listLlmConfigsForOrg scoped to org B returns exactly org B's two configs, never org A's", async () => {
    const rows = await listLlmConfigsForOrg(db, unsafeOrgScope(orgBId));
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual([configBDefaultId, configBNonDefaultId].sort());
    expect(ids).not.toContain(configAId);
  });

  it("listLlmConfigsForOrg scoped to org A returns only org A's single config", async () => {
    const rows = await listLlmConfigsForOrg(db, unsafeOrgScope(orgAId));
    expect(rows.map((r) => r.id)).toEqual([configAId]);
  });

  // Mutation-check: org B has two configs, only one is_default=true -- if
  // getDefaultLlmConfig's organizationId filter were dropped (leaving only
  // the is_default filter), this could still coincidentally return the
  // right row since org A's config is also is_default=true. Assert on org
  // B specifically, where the non-default sibling proves the query isn't
  // just "the first default config in the whole table".
  it("getDefaultLlmConfig scoped to org B returns org B's default, not org A's or org B's non-default config", async () => {
    const found = await getDefaultLlmConfig(db, unsafeOrgScope(orgBId));
    expect(found?.id).toBe(configBDefaultId);
  });

  it("getDefaultLlmConfig returns undefined for an org with no default config", async () => {
    const [orgC] = await db
      .insert(organizations)
      .values({ slug: `llmcfg-c-${crypto.randomUUID()}`, name: "C", workosOrganizationId: `w-c-${crypto.randomUUID()}` })
      .returning({ id: organizations.id });
    const found = await getDefaultLlmConfig(db, unsafeOrgScope(orgC.id));
    expect(found).toBeUndefined();
    await db.delete(organizations).where(eq(organizations.id, orgC.id));
  });

  // #161: the cross-tenant check updateHomeworkHandler relies on before
  // writing llmConfigId through.
  it("llmConfigBelongsToOrg returns true only when the id and org both match, false for a real id under the wrong org", async () => {
    expect(await llmConfigBelongsToOrg(db, unsafeOrgScope(orgAId), configAId)).toBe(true);
    // configBDefaultId is a real, existing llmConfig row -- just not org A's.
    expect(await llmConfigBelongsToOrg(db, unsafeOrgScope(orgAId), configBDefaultId)).toBe(false);
  });

  it("llmConfigBelongsToOrg returns false for a well-formed but nonexistent id", async () => {
    expect(await llmConfigBelongsToOrg(db, unsafeOrgScope(orgAId), "00000000-0000-0000-0000-000000000000")).toBe(false);
  });
});

/* --------------------------------------------------------------------------
   #31 / #170 / #98: config authoring, against a real Postgres.

   Real-DB and not mocked, because three of the invariants under test are
   enforced by the DATABASE rather than by the query builder:
   `llm_configs_org_default_uq` (at most one default per org),
   `llm_configs_active_required_for_default_chk`, and
   `llm_configs_fallback_not_self_chk`. A mocked db would echo back whatever
   it was handed and pass whether or not any of them exist.
   -------------------------------------------------------------------------- */
describe.skipIf(!DATABASE_URL)("llmConfigs authoring (#31, #170, #98)", () => {
  let db: Db;
  let orgId: string;
  let otherOrgId: string;
  let courseId: string;

  const input = (over: Partial<LlmConfigInput> = {}): LlmConfigInput => ({
    name: "Socratic",
    provider: "openrouter",
    modelName: "google/gemma-4-31b-it:free",
    basePrompt: "You are a tutor.",
    temperature: 0.7,
    maxCompletionTokens: 1000,
    fallbackLlmConfigId: null,
    isActive: true,
    isDefault: false,
    ...over,
  });

  beforeAll(async () => {
    db = makeNodeDb(DATABASE_URL!);
    const [org] = await db
      .insert(organizations)
      .values({
        slug: `cfg-${crypto.randomUUID()}`,
        name: "Cfg org",
        workosOrganizationId: `w-${crypto.randomUUID()}`,
      })
      .returning({ id: organizations.id });
    orgId = org!.id;
    const [other] = await db
      .insert(organizations)
      .values({
        slug: `cfg2-${crypto.randomUUID()}`,
        name: "Other org",
        workosOrganizationId: `w-${crypto.randomUUID()}`,
      })
      .returning({ id: organizations.id });
    otherOrgId = other!.id;
    const [course] = await db
      .insert(courses)
      .values({ organizationId: orgId, code: "CFG", term: "T", title: "Cfg" })
      .returning({ id: courses.id });
    courseId = course!.id;
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, otherOrgId));
  });

  /** Each test starts from an empty pool for `orgId`, so default-promotion
   *  order is never inherited from a neighbour. */
  async function reset() {
    await db.delete(llmConfigs).where(eq(llmConfigs.organizationId, orgId));
  }

  it("numbers configs per org from oldest to newest, independent of list order", async () => {
    await reset();
    const first = await createLlmConfig(db, unsafeOrgScope(orgId), input({ name: "First" }));
    const second = await createLlmConfig(db, unsafeOrgScope(orgId), input({ name: "Second" }));
    // The badge is CFG·001 for the oldest, while the LIST is newest-first --
    // the two orders are deliberately opposite, so this pins both.
    expect(first.recordNumber).toBe(1);
    expect(second.recordNumber).toBe(2);
    const listed = await listLlmConfigsForOrg(db, unsafeOrgScope(orgId));
    expect(listed.map((c) => c.name)).toEqual(["Second", "First"]);
    expect(listed.map((c) => c.recordNumber)).toEqual([2, 1]);
  });

  it("keeps exactly one default when a second config is promoted", async () => {
    await reset();
    const a = await createLlmConfig(db, unsafeOrgScope(orgId), input({ name: "A", isDefault: true }));
    const b = await createLlmConfig(db, unsafeOrgScope(orgId), input({ name: "B", isDefault: true }));
    const all = await listLlmConfigsForOrg(db, unsafeOrgScope(orgId));
    // Data corruption if this ever fails: two defaults means resolution picks
    // arbitrarily and two courses run on different models for one setting.
    expect(all.filter((c) => c.isDefault).map((c) => c.id)).toEqual([b.id]);
    expect(all.find((c) => c.id === a.id)!.isDefault).toBe(false);
  });

  it("promotes on update as well as on create", async () => {
    await reset();
    const a = await createLlmConfig(db, unsafeOrgScope(orgId), input({ name: "A", isDefault: true }));
    const b = await createLlmConfig(db, unsafeOrgScope(orgId), input({ name: "B" }));
    await updateLlmConfig(db, unsafeOrgScope(orgId), b.id, input({ name: "B", isDefault: true }));
    const all = await listLlmConfigsForOrg(db, unsafeOrgScope(orgId));
    expect(all.filter((c) => c.isDefault).map((c) => c.id)).toEqual([b.id]);
    expect(all.find((c) => c.id === a.id)!.isDefault).toBe(false);
  });

  it("refuses at the database to make an inactive config the default", async () => {
    await reset();
    const a = await createLlmConfig(db, unsafeOrgScope(orgId), input({ name: "A" }));
    await db
      .update(llmConfigs)
      .set({ isActive: false })
      .where(eq(llmConfigs.id, a.id));
    // The route rejects this shape first with a readable sentence; the
    // constraint is what holds when something else tries.
    await expect(
      db.update(llmConfigs).set({ isDefault: true }).where(eq(llmConfigs.id, a.id)),
    ).rejects.toThrow(/llm_configs_active_required_for_default_chk/);
  });

  it("will not deactivate the default, and says which case it is", async () => {
    await reset();
    const a = await createLlmConfig(db, unsafeOrgScope(orgId), input({ name: "A", isDefault: true }));
    const b = await createLlmConfig(db, unsafeOrgScope(orgId), input({ name: "B" }));
    // Deactivating the default is an org-wide outage wearing the clothes of a
    // settings change: every unpinned course resolves through it.
    expect(await deactivateLlmConfig(db, unsafeOrgScope(orgId), a.id)).toBe("is_default");
    expect(await deactivateLlmConfig(db, unsafeOrgScope(orgId), b.id)).toBe("deactivated");
    expect(await deactivateLlmConfig(db, unsafeOrgScope(otherOrgId), a.id)).toBe("not_found");
  });

  it("hides another org's config from every read and write path", async () => {
    await reset();
    const mine = await createLlmConfig(db, unsafeOrgScope(orgId), input({ name: "Mine" }));
    // A single missing org filter is a privilege escalation, so each entry
    // point is checked rather than trusting one shared helper.
    expect(await getLlmConfig(db, unsafeOrgScope(otherOrgId), mine.id)).toBeNull();
    expect(
      await updateLlmConfig(db, unsafeOrgScope(otherOrgId), mine.id, input({ name: "Hijacked" })),
    ).toBeNull();
    expect(await cloneLlmConfig(db, unsafeOrgScope(otherOrgId), mine.id, "Copy")).toBeNull();
    expect(await listLlmConfigsForOrg(db, unsafeOrgScope(otherOrgId))).toEqual([]);
    // And the row is untouched.
    expect((await getLlmConfig(db, unsafeOrgScope(orgId), mine.id))!.name).toBe("Mine");
  });

  it("clones as a non-default editable copy, sharing the credential reference", async () => {
    await reset();
    const source = await createLlmConfig(
      db,
      unsafeOrgScope(orgId),
      input({ name: "Source", isDefault: true, basePrompt: "Be Socratic." }),
    );
    const clone = await cloneLlmConfig(db, unsafeOrgScope(orgId), source.id, "Experiment");

    expect(clone!.name).toBe("Experiment");
    expect(clone!.basePrompt).toBe("Be Socratic.");
    // A clone that inherited is_default would repoint every course in the
    // organization at an untested config the moment it was created.
    expect(clone!.isDefault).toBe(false);
    expect((await getLlmConfig(db, unsafeOrgScope(orgId), source.id))!.isDefault).toBe(true);
    // No secret is duplicated: the credential is a REFERENCE, unlike the
    // upstream fork's plaintext api_key copied into every derived config.
    const rows = await db
      .select({ credentialId: llmConfigs.credentialId })
      .from(llmConfigs)
      .where(eq(llmConfigs.id, clone!.id));
    expect(rows[0]!.credentialId).toBeNull();
  });

  describe("resolveLlmConfig (#170)", () => {
    it("prefers the homework's pinned config over the org default", async () => {
      await reset();
      const orgDefault = await createLlmConfig(
        db,
        unsafeOrgScope(orgId),
        input({ name: "Org default", isDefault: true }),
      );
      const pinned = await createLlmConfig(db, unsafeOrgScope(orgId), input({ name: "Pinned" }));
      const homeworkId = await makeHomework(pinned.id);

      expect((await resolveLlmConfig(db, unsafeOrgScope(orgId), { homeworkId }))!.id).toBe(
        pinned.id,
      );
      expect((await resolveLlmConfig(db, unsafeOrgScope(orgId), {}))!.id).toBe(orgDefault.id);
    });

    it("#421: prefers the course's config over the org default, and the homework's over the course's", async () => {
      await reset();
      await createLlmConfig(db, unsafeOrgScope(orgId), input({ name: "Org default", isDefault: true }));
      const courseConfig = await createLlmConfig(db, unsafeOrgScope(orgId), input({ name: "Course" }));
      const pinned = await createLlmConfig(db, unsafeOrgScope(orgId), input({ name: "Pinned" }));
      const homeworkId = await makeHomework(pinned.id);

      /* #325 gave `courses` an llm_config_id and this walk was never updated,
         so a course-level override resolved to the ORG DEFAULT here while the
         chat path resolved it to the course's config -- the instructor's
         draft grade ran on a different model than the conversation it was
         grading. */
      expect(
        (await resolveLlmConfig(db, unsafeOrgScope(orgId), { courseLlmConfigId: courseConfig.id }))!.id,
      ).toBe(courseConfig.id);

      // The homework pin still wins over the course, matching lib/llm-config's
      // homework -> course -> org-default order exactly.
      expect(
        (await resolveLlmConfig(db, unsafeOrgScope(orgId), { homeworkId, courseLlmConfigId: courseConfig.id }))!.id,
      ).toBe(pinned.id);
    });

    it("#421: ignores a course config that is inactive or belongs to another org", async () => {
      await reset();
      const orgDefault = await createLlmConfig(
        db,
        unsafeOrgScope(orgId),
        input({ name: "Org default", isDefault: true }),
      );
      const inactive = await createLlmConfig(
        db,
        unsafeOrgScope(orgId),
        input({ name: "Retired course config", isActive: false }),
      );

      // Same is_active and org predicates the other tiers apply -- a course
      // pointing at a retired config falls through rather than resolving to
      // something the admin has switched off.
      expect(
        (await resolveLlmConfig(db, unsafeOrgScope(orgId), { courseLlmConfigId: inactive.id }))!.id,
      ).toBe(orgDefault.id);
      expect(
        (await resolveLlmConfig(db, unsafeOrgScope(orgId), { courseLlmConfigId: crypto.randomUUID() }))!.id,
      ).toBe(orgDefault.id);
    });

    it("falls through to the org default when the pinned config was deactivated", async () => {
      await reset();
      const orgDefault = await createLlmConfig(
        db,
        unsafeOrgScope(orgId),
        input({ name: "Org default", isDefault: true }),
      );
      const pinned = await createLlmConfig(db, unsafeOrgScope(orgId), input({ name: "Pinned" }));
      const homeworkId = await makeHomework(pinned.id);
      await deactivateLlmConfig(db, unsafeOrgScope(orgId), pinned.id);

      // Running on a config an instructor deliberately retired is worse than
      // running on the org default.
      expect((await resolveLlmConfig(db, unsafeOrgScope(orgId), { homeworkId }))!.id).toBe(
        orgDefault.id,
      );
    });

    it("resolves from a section by way of its homework", async () => {
      await reset();
      await createLlmConfig(db, unsafeOrgScope(orgId), input({ name: "Org default", isDefault: true }));
      const pinned = await createLlmConfig(db, unsafeOrgScope(orgId), input({ name: "Pinned" }));
      const homeworkId = await makeHomework(pinned.id);
      const [section] = await db
        .insert(sections)
        .values({ homeworkId, title: "S1", content: "c", order: 1 })
        .returning({ id: sections.id });

      expect(
        (await resolveLlmConfig(db, unsafeOrgScope(orgId), { sectionId: section!.id }))!.id,
      ).toBe(pinned.id);
    });

    it("returns null for an org with no usable default rather than guessing", async () => {
      await reset();
      // A brand-new organization, and the momentary state after a half-failed
      // promotion. Callers degrade to the platform prompt; they must not be
      // handed some other org's config or an arbitrary local one.
      expect(await resolveLlmConfig(db, unsafeOrgScope(orgId), {})).toBeNull();
      await createLlmConfig(db, unsafeOrgScope(orgId), input({ name: "Not default" }));
      expect(await resolveLlmConfig(db, unsafeOrgScope(orgId), {})).toBeNull();
    });
  });

  describe("resolveFallbackLLMConfig (#98/#364)", () => {
    it("returns the configured fallback, and nothing when it was deactivated", async () => {
      await reset();
      const backup = await createLlmConfig(db, unsafeOrgScope(orgId), input({ name: "Backup" }));
      const primary = await createLlmConfig(
        db,
        unsafeOrgScope(orgId),
        input({ name: "Primary", fallbackLlmConfigId: backup.id }),
      );

      expect((await resolveFallbackLLMConfig(db, unsafeOrgScope(orgId), primary))!.id).toBe(backup.id);
      await deactivateLlmConfig(db, unsafeOrgScope(orgId), backup.id);
      // An instructor who retires a config has not said "except when the
      // primary is down".
      expect(await resolveFallbackLLMConfig(db, unsafeOrgScope(orgId), primary)).toBeNull();
    });

    it("returns null when no fallback is configured", async () => {
      await reset();
      const solo = await createLlmConfig(db, unsafeOrgScope(orgId), input({ name: "Solo" }));
      expect(await resolveFallbackLLMConfig(db, unsafeOrgScope(orgId), solo)).toBeNull();
    });

    it("returns null rather than degrading to the org default when the fallback is gone", async () => {
      // #364's whole reason for NOT reusing resolveLLMConfig here: that
      // function cannot fail, so an unresolvable fallback id would fall
      // through to the ORG DEFAULT -- which is what most turns resolve their
      // PRIMARY to, so the "failover" would retry the model that just failed.
      await reset();
      await createLlmConfig(db, unsafeOrgScope(orgId), input({ name: "Org default", isDefault: true }));
      const primary = await createLlmConfig(
        db,
        unsafeOrgScope(orgId),
        // A fallback id that resolves to nothing under this org -- the state
        // an ON DELETE SET NULL race or a cross-tenant id would produce.
        input({ name: "Primary", fallbackLlmConfigId: null }),
      );
      expect(
        await resolveFallbackLLMConfig(db, unsafeOrgScope(orgId), {
          fallbackLlmConfigId: crypto.randomUUID(),
        }),
      ).toBeNull();
      expect(await resolveFallbackLLMConfig(db, unsafeOrgScope(orgId), primary)).toBeNull();
    });

    it("will not resolve a fallback belonging to another organization", async () => {
      await reset();
      const foreign = await createLlmConfig(db, unsafeOrgScope(otherOrgId), input({ name: "Foreign" }));
      expect(
        await resolveFallbackLLMConfig(db, unsafeOrgScope(orgId), { fallbackLlmConfigId: foreign.id }),
      ).toBeNull();
    });

    it("refuses a self-referencing fallback at the database", async () => {
      await reset();
      const solo = await createLlmConfig(db, unsafeOrgScope(orgId), input({ name: "Solo" }));
      // At depth one this is the entire cycle problem -- the resolver reads
      // exactly one hop, so there is no A -> B -> A to detect.
      await expect(
        db
          .update(llmConfigs)
          .set({ fallbackLlmConfigId: solo.id })
          .where(eq(llmConfigs.id, solo.id)),
      ).rejects.toThrow(/llm_configs_fallback_not_self_chk/);
    });
  });

  async function makeHomework(llmConfigId: string): Promise<string> {
    const [user] = await db
      .insert(users)
      .values({
        email: crypto.getRandomValues(new Uint8Array(16)) as never,
        emailBlindIndex: crypto.getRandomValues(new Uint8Array(32)) as never,
      })
      .returning({ id: users.id });
    const [membership] = await db
      .insert(courseMemberships)
      .values({ userId: user!.id, courseId, role: "instructor" })
      .returning({ id: courseMemberships.id });
    const [hw] = await db
      .insert(homeworks)
      .values({
        courseId,
        createdById: membership!.id,
        llmConfigId,
        title: "HW",
        description: "d",
        dueDate: new Date(Date.now() + 86_400_000),
      })
      .returning({ id: homeworks.id });
    return hw!.id;
  }
});
