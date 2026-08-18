import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { homeworks, llmConfigs, sections } from "../../db/schema";
import type { OrgScope } from "./scope";
import type { LlmConfigPayload } from "@llteacher/ui/api";

/** A config as the admin console reads it, with the display ordinal the
 *  catalog badge (`CFG·001`) needs.
 *
 *  #33 asked for the display-id rule to be defined and documented, so:
 *  **recordNumber is a per-organization ordinal over `created_at, id`,
 *  computed at read time and never stored.** Consequences, stated because
 *  they are the reason for the choice rather than accidents of it:
 *
 *   · It is stable for a given set of rows, because `id` breaks ties on
 *     identical `created_at` -- without that, two configs created in the same
 *     millisecond would swap badges between page loads.
 *   · It is NOT stable across deletion. Deleting CFG·002 renumbers everything
 *     after it. That is acceptable here only because configs are deactivated
 *     rather than deleted (deactivate is the sanctioned path; see
 *     deactivateLlmConfig), so the sequence does not close up in practice.
 *   · It is deliberately not a stored sequence column. A stored one would
 *     survive deletion, but would also need backfilling, a per-org counter,
 *     and its own uniqueness constraint -- machinery for a number whose only
 *     job is to give an instructor something short to say out loud.
 *
 *  The id is the identity; recordNumber is a label. Nothing keys off it. */
export interface LlmConfigRecord {
  id: string;
  recordNumber: number;
  name: string;
  provider: (typeof llmConfigs.$inferSelect)["provider"];
  modelName: string;
  basePrompt: string;
  temperature: number;
  maxCompletionTokens: number;
  fallbackLlmConfigId: string | null;
  isDefault: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** #33: the repository's shape IS the wire contract, checked rather than
 *  asserted. `@llteacher/ui/api` is where apps/admin reads the same
 *  definition from, so a field renamed here and not there stops compiling
 *  instead of failing a runtime parse in the console.
 *
 *  Two-way on purpose: the first line catches a field the server dropped,
 *  the second catches one the server added without telling the client. A
 *  single `satisfies` would only catch the first. */
type _RecordMatchesWire = LlmConfigRecord extends LlmConfigPayload ? true : never;
type _WireMatchesRecord = LlmConfigPayload extends LlmConfigRecord ? true : never;
const _contractHolds: [_RecordMatchesWire, _WireMatchesRecord] = [true, true];
void _contractHolds;

/** Aliased explicitly: `getLlmConfig` selects from this as a subquery so the
 *  window function sees the org's whole partition, and Drizzle cannot
 *  reference a raw SQL field across a subquery boundary without a name. */
const RECORD_NUMBER = sql<number>`
  row_number() over (
    partition by ${llmConfigs.organizationId}
    order by ${llmConfigs.createdAt} asc, ${llmConfigs.id} asc
  )::int
`.as("recordNumber");

/** Every field the console reads, projected explicitly rather than
 *  `select()`-ing the table. Same reason listMembershipsForUser does it
 *  (#172 audit, CMP-001): Drizzle emits the column list from the compiled
 *  schema, so an additive column deployed ahead of its migration takes the
 *  route down with "column does not exist" instead of degrading. */
const CONFIG_COLUMNS = {
  id: llmConfigs.id,
  recordNumber: RECORD_NUMBER,
  name: llmConfigs.name,
  provider: llmConfigs.provider,
  modelName: llmConfigs.modelName,
  basePrompt: llmConfigs.basePrompt,
  temperature: llmConfigs.temperature,
  maxCompletionTokens: llmConfigs.maxCompletionTokens,
  fallbackLlmConfigId: llmConfigs.fallbackLlmConfigId,
  isDefault: llmConfigs.isDefault,
  isActive: llmConfigs.isActive,
  createdAt: llmConfigs.createdAt,
  updatedAt: llmConfigs.updatedAt,
};

function toRecord(r: {
  createdAt: Date | string;
  updatedAt: Date | string;
  [k: string]: unknown;
}): LlmConfigRecord {
  return {
    ...(r as unknown as Omit<LlmConfigRecord, "createdAt" | "updatedAt">),
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

/** #31: the org's configs, newest first, with display ordinals.
 *
 *  Org-scoped, and that scope is wider than the caller's authorization: the
 *  routes gate on instructor-of-COURSE and then resolve that course's org.
 *  So an instructor of one course can read and edit configs that other
 *  courses in the same organization use, including the org default.
 *
 *  That is the schema's design (`llm_configs` is documented as a
 *  per-organization pool) and not an oversight, but it is a real widening
 *  and belongs stated: within one UW organization, course staff are trusted
 *  with the shared model pool. If that stops being true -- multiple
 *  unrelated departments in one org -- the fix is course-scoped configs, not
 *  a narrower query here. */
export async function listLlmConfigsForOrg(
  db: Db,
  scope: OrgScope,
): Promise<LlmConfigRecord[]> {
  const rows = await db
    .select(CONFIG_COLUMNS)
    .from(llmConfigs)
    .where(eq(llmConfigs.organizationId, scope))
    .orderBy(desc(llmConfigs.createdAt), desc(llmConfigs.id));
  return rows.map(toRecord);
}

/** One config, or null when it does not exist under this org scope.
 *  "Wrong org" and "no such id" are indistinguishable to the caller by
 *  design -- the same property the TA routes preserve. */
export async function getLlmConfig(
  db: Db,
  scope: OrgScope,
  id: string,
): Promise<LlmConfigRecord | null> {
  // The window function needs the org's full partition to number correctly,
  // so this filters the numbered set rather than numbering a filtered one --
  // numbering a single row would always produce recordNumber 1.
  const numbered = db
    .select(CONFIG_COLUMNS)
    .from(llmConfigs)
    .where(eq(llmConfigs.organizationId, scope))
    .as("numbered");
  const [row] = await db.select().from(numbered).where(eq(numbered.id, id));
  return row ? toRecord(row) : null;
}

export async function getDefaultLlmConfig(db: Db, scope: OrgScope) {
  const [found] = await db
    .select()
    .from(llmConfigs)
    .where(and(eq(llmConfigs.organizationId, scope), eq(llmConfigs.isDefault, true)));
  return found;
}

/** #161: `homeworks.llm_config_id`'s FK only requires the row to exist
 *  somewhere -- not that it belongs to the caller's tenant. Cheap existence
 *  check under the given org scope, called before writing the id through. */
export async function llmConfigBelongsToOrg(db: Db, scope: OrgScope, id: string): Promise<boolean> {
  const [found] = await db
    .select({ id: llmConfigs.id })
    .from(llmConfigs)
    .where(and(eq(llmConfigs.id, id), eq(llmConfigs.organizationId, scope)));
  return !!found;
}

export interface LlmConfigInput {
  name: string;
  provider: LlmConfigRecord["provider"];
  modelName: string;
  basePrompt: string;
  temperature: number;
  maxCompletionTokens: number;
  fallbackLlmConfigId: string | null;
  isActive: boolean;
  isDefault: boolean;
}

/** Promotes one config to the org default, clearing whichever held it.
 *
 *  Two statements, clear then set, because neon-http has no interactive
 *  transactions -- the same constraint UserIdentityService documents. The
 *  ordering is the recoverable one:
 *
 *   · clear-then-set can leave the org briefly with NO default if the second
 *     statement fails. resolveLlmConfig treats that as "no org default" and
 *     degrades to the platform prompt, and the instructor's next save fixes
 *     it. A visible, self-correcting degradation.
 *   · set-then-clear would violate `llm_configs_org_default_uq` on the FIRST
 *     statement whenever a default already exists, so it cannot even be
 *     attempted.
 *
 *  The partial unique index remains the actual enforcement, not this
 *  sequence: two instructors promoting different configs concurrently both
 *  clear, then race to set, and the index rejects the loser. The route maps
 *  that to a conflict rather than pretending it succeeded. */
async function promoteToDefault(db: Db, scope: OrgScope, id: string): Promise<void> {
  await db
    .update(llmConfigs)
    .set({ isDefault: false, updatedAt: new Date() })
    .where(
      and(
        eq(llmConfigs.organizationId, scope),
        eq(llmConfigs.isDefault, true),
        ne(llmConfigs.id, id),
      ),
    );
  await db
    .update(llmConfigs)
    .set({ isDefault: true, updatedAt: new Date() })
    .where(and(eq(llmConfigs.id, id), eq(llmConfigs.organizationId, scope)));
}

/** #31: creates a config under the given org.
 *
 *  Inserted non-default and promoted afterwards when asked, rather than
 *  inserting with `is_default = true` directly: inserting a second default
 *  violates the partial unique index, so the insert would fail against any
 *  org that already has one -- which is every org after the first config. */
export async function createLlmConfig(
  db: Db,
  scope: OrgScope,
  input: LlmConfigInput,
): Promise<LlmConfigRecord> {
  const [created] = await db
    .insert(llmConfigs)
    .values({
      organizationId: scope,
      name: input.name,
      provider: input.provider,
      modelName: input.modelName,
      basePrompt: input.basePrompt,
      temperature: input.temperature,
      maxCompletionTokens: input.maxCompletionTokens,
      fallbackLlmConfigId: input.fallbackLlmConfigId,
      isActive: input.isActive,
      isDefault: false,
    })
    .returning({ id: llmConfigs.id });

  if (input.isDefault) await promoteToDefault(db, scope, created!.id);
  return (await getLlmConfig(db, scope, created!.id))!;
}

/** #31: updates a config in place. Returns null when no row matched the org
 *  scope, which the route maps to 404.
 *
 *  Demotion is deliberately not offered: clearing `isDefault` on the only
 *  default would leave the org with none, and the console never asks for
 *  that -- an instructor picks a *different* default instead, which is a
 *  promotion of that one. So `isDefault: false` on the current default is a
 *  no-op rather than a demotion. */
export async function updateLlmConfig(
  db: Db,
  scope: OrgScope,
  id: string,
  input: LlmConfigInput,
): Promise<LlmConfigRecord | null> {
  const [updated] = await db
    .update(llmConfigs)
    .set({
      name: input.name,
      provider: input.provider,
      modelName: input.modelName,
      basePrompt: input.basePrompt,
      temperature: input.temperature,
      maxCompletionTokens: input.maxCompletionTokens,
      fallbackLlmConfigId: input.fallbackLlmConfigId,
      isActive: input.isActive,
      updatedAt: new Date(),
    })
    .where(and(eq(llmConfigs.id, id), eq(llmConfigs.organizationId, scope)))
    .returning({ id: llmConfigs.id });
  if (!updated) return null;

  if (input.isDefault) await promoteToDefault(db, scope, id);
  return getLlmConfig(db, scope, id);
}

export type DeactivateOutcome = "deactivated" | "not_found" | "is_default";

/** #31: deactivate, never delete -- Django parity, and the reason is
 *  referential rather than sentimental: `homeworks.llm_config_id` points at
 *  these rows, and conversations record which config produced them.
 *
 *  The default cannot be deactivated. It is what every course without an
 *  explicit choice resolves to, so deactivating it is an org-wide outage
 *  wearing the clothes of a settings change. The database agrees --
 *  `llm_configs_active_required_for_default_chk` rejects the row -- but this
 *  returns a nameable outcome so the console can say "make another config
 *  the default first" instead of surfacing a constraint violation. */
export async function deactivateLlmConfig(
  db: Db,
  scope: OrgScope,
  id: string,
): Promise<DeactivateOutcome> {
  const [row] = await db
    .select({ isDefault: llmConfigs.isDefault })
    .from(llmConfigs)
    .where(and(eq(llmConfigs.id, id), eq(llmConfigs.organizationId, scope)));
  if (!row) return "not_found";
  if (row.isDefault) return "is_default";

  // Org scope stays in the WHERE clause rather than being trusted from the
  // read above -- check-then-act on a different key is the gap #174 found.
  const [updated] = await db
    .update(llmConfigs)
    .set({ isActive: false, updatedAt: new Date() })
    .where(
      and(
        eq(llmConfigs.id, id),
        eq(llmConfigs.organizationId, scope),
        eq(llmConfigs.isDefault, false),
      ),
    )
    .returning({ id: llmConfigs.id });
  return updated ? "deactivated" : "not_found";
}

/** #170: an editable copy of an existing config, under the same org.
 *
 *  Three properties, each of which is the point rather than a detail:
 *
 *   · The clone is never the default. Cloning is how an instructor
 *     experiments; a clone that inherited `is_default` would silently
 *     repoint every course in the organization at an untested config the
 *     moment it was created.
 *   · The clone is never active-by-inheritance either -- it copies
 *     `isActive`, which for the normal case (cloning a live config) is true,
 *     but a clone of a retired config stays retired.
 *   · No secret is duplicated. The upstream fork's GlobalLLMDefault copies a
 *     plaintext `api_key` field into every derived config; ours carries a
 *     `credentialId` REFERENCE, and the clone shares the same reference
 *     rather than copying any material. There is no plaintext to duplicate,
 *     which is the whole reason the credential model is a pointer.
 *
 *  Returns null when the source is not in this org -- so a config from
 *  another organization cannot be read even indirectly, by cloning it. */
export async function cloneLlmConfig(
  db: Db,
  scope: OrgScope,
  sourceId: string,
  name: string,
): Promise<LlmConfigRecord | null> {
  const [source] = await db
    .select()
    .from(llmConfigs)
    .where(and(eq(llmConfigs.id, sourceId), eq(llmConfigs.organizationId, scope)));
  if (!source) return null;

  const [created] = await db
    .insert(llmConfigs)
    .values({
      organizationId: scope,
      name,
      provider: source.provider,
      modelName: source.modelName,
      basePrompt: source.basePrompt,
      temperature: source.temperature,
      maxCompletionTokens: source.maxCompletionTokens,
      // Shared reference, never duplicated material -- see above.
      credentialId: source.credentialId,
      fallbackLlmConfigId: source.fallbackLlmConfigId,
      isActive: source.isActive,
      isDefault: false,
    })
    .returning({ id: llmConfigs.id });
  return getLlmConfig(db, scope, created!.id);
}

/** #170: the config a given piece of work runs under.
 *
 *  **Resolution order: the section's homework, then the org default.**
 *
 *  The upstream fork carries a separate global-template model whose only job
 *  is minting per-course configs. That does not port: their LLMConfig is
 *  course-scoped, ours is org-scoped with a partial unique index enforcing
 *  one default per org -- so the org default already plays the role their
 *  GlobalLLMDefault plays, and adding a third tier would create exactly the
 *  drift their two-model design risks.
 *
 *  There is deliberately no course tier between the two. `courses` carries no
 *  llm_config_id column, and inventing one here would mean a resolution step
 *  that reads a column nothing writes. When a course tier is genuinely
 *  wanted, it goes in the schema first and then in the middle of this
 *  function; the order is documented so that insertion point is obvious.
 *
 *  Returns null when the org has no usable default -- which the caller must
 *  handle rather than assume away. That happens for a brand-new organization,
 *  and momentarily if a promotion half-failed (see promoteToDefault). Callers
 *  degrade to the platform prompt; they do not fail the student's turn.
 *
 *  Inactive configs are skipped at every tier: a homework pinned to a config
 *  that was later deactivated resolves onward to the org default rather than
 *  running on a config an instructor deliberately retired. */
export async function resolveLlmConfig(
  db: Db,
  scope: OrgScope,
  target: { sectionId?: string; homeworkId?: string },
): Promise<LlmConfigRecord | null> {
  let homeworkId = target.homeworkId;

  if (!homeworkId && target.sectionId) {
    const [row] = await db
      .select({ homeworkId: sections.homeworkId })
      .from(sections)
      .where(eq(sections.id, target.sectionId));
    homeworkId = row?.homeworkId;
  }

  if (homeworkId) {
    // Joined rather than read-then-read, so the org check is part of the
    // same query as the lookup: a homework in another organization cannot
    // pull that organization's config through this path.
    const [pinned] = await db
      .select(CONFIG_COLUMNS)
      .from(llmConfigs)
      .innerJoin(homeworks, eq(homeworks.llmConfigId, llmConfigs.id))
      .where(
        and(
          eq(homeworks.id, homeworkId),
          eq(llmConfigs.organizationId, scope),
          eq(llmConfigs.isActive, true),
        ),
      );
    if (pinned) return toRecord(pinned);
  }

  const [orgDefault] = await db
    .select(CONFIG_COLUMNS)
    .from(llmConfigs)
    .where(
      and(
        eq(llmConfigs.organizationId, scope),
        eq(llmConfigs.isDefault, true),
        eq(llmConfigs.isActive, true),
      ),
    )
    .orderBy(asc(llmConfigs.createdAt));
  return orgDefault ? toRecord(orgDefault) : null;
}

/** #98: the one configured fallback for a config, or null.
 *
 *  Exactly one hop, never a walk. `fallbackLlmConfigId` on the *fallback* is
 *  not consulted, which is what makes the depth-one design safe without
 *  cycle detection: there is no traversal to loop. The self-reference CHECK
 *  in the schema closes the only remaining degenerate case.
 *
 *  A deactivated fallback resolves to null -- an instructor who retires a
 *  config has said it should not serve traffic, and "except when the primary
 *  is down" is not a thing they said. */
export async function resolveFallbackConfig(
  db: Db,
  scope: OrgScope,
  config: Pick<LlmConfigRecord, "fallbackLlmConfigId">,
): Promise<LlmConfigRecord | null> {
  if (!config.fallbackLlmConfigId) return null;
  const found = await getLlmConfig(db, scope, config.fallbackLlmConfigId);
  return found?.isActive ? found : null;
}
