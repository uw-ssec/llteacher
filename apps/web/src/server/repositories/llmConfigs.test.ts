import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { makeNodeDb } from "../../db/nodeClient";
import type { Db } from "../../db/client";
import { organizations, llmConfigs } from "../../db/schema";
import { unsafeOrgScope } from "./scope";
import { listLlmConfigsForOrg, getDefaultLlmConfig, llmConfigBelongsToOrg } from "./llmConfigs";

const DATABASE_URL = process.env.DATABASE_URL;

// #149: listLlmConfigsForOrg/getDefaultLlmConfig had zero test coverage
// despite the Phase-4 commit claiming cross-org isolation tests for every
// repository it added. No production route calls either function yet, but
// this isn't dead code awaiting deletion -- it's awaiting M5's LLM config
// CRUD admin routes (listLlmConfigsForOrg) and #143's chat hardening, which
// needs getDefaultLlmConfig to resolve the model from the caller's org
// instead of the hardcoded fallback (chat.ts:96) it uses today.
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
      .values({ organizationId: orgAId, provider: "anthropic", modelName: "claude-sonnet", isDefault: true })
      .returning({ id: llmConfigs.id });
    configAId = configA.id;

    const [configBDefault] = await db
      .insert(llmConfigs)
      .values({ organizationId: orgBId, provider: "openai", modelName: "gpt-5", isDefault: true })
      .returning({ id: llmConfigs.id });
    configBDefaultId = configBDefault.id;
    const [configBNonDefault] = await db
      .insert(llmConfigs)
      .values({ organizationId: orgBId, provider: "openrouter", modelName: "free-tier", isDefault: false })
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
