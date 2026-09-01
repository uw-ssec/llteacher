import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { courses, llmConfigs, organizationCredentials } from "../db/schema";
import type { CourseScope, OrgScope } from "../server/repositories/scope";
import { getOpenRouter, getLLMoxie } from "./ai";

/* --------------------------------------------------------------------------
   Per-homework LLM config resolution (#26) -- replaces chat.ts's hardcoded
   `google/gemma-4-31b-it:free` model with the model/provider/params a real
   `llm_configs` row specifies.

   Three steps, kept separate (mirrors lib/prompts.ts's split for the same
   reason -- each is independently testable, and #178 only had to extend
   the last one to add LLMoxie):

     resolveLLMConfig      -- WHICH config row applies (homework override ->
                               org default -> LLMConfigNotFoundError, Django
                               parity: LLMService._get_llm_config /
                               get_default_config)
     resolveApiKey          -- the actual key for that row's provider,
                               resolved from an env binding, never a
                               plaintext DB column
     buildProviderClient    -- the AI SDK provider factory for that row's
                               provider ("openrouter" and "llmoxie" today)

   #364 adds a fourth, deliberately NOT a fifth: `resolveFallbackLLMConfig`
   (the one configured failover hop) reads through the SAME
   `loadLLMConfigById` primitive `resolveLLMConfig`'s own override branches
   use, so a failover config is loaded, keyed and clients-built by exactly
   the pair above -- never a second, parallel resolution mechanism that
   could drift on provider/credential handling. See that function's own doc
   comment for why it is not just `resolveLLMConfig` called with the
   fallback id.
   -------------------------------------------------------------------------- */

export type LlmProvider = "openai" | "anthropic" | "claude_for_education" | "openrouter" | "local" | "llmoxie";

/** Django parity (LLMService.get_response's `if not llm_config: ...
 *  logger.error(...); return "...reference ID: {error_id}"`): a random,
 *  logged id the client can quote to an administrator, without leaking
 *  which org/homework/config lookup actually failed. */
export class LLMConfigNotFoundError extends Error {
  readonly referenceId: string;
  constructor() {
    const referenceId = crypto.randomUUID();
    super(`No active LLM configuration available. Reference ID: ${referenceId}`);
    this.name = "LLMConfigNotFoundError";
    this.referenceId = referenceId;
  }
}

/** A config resolved to a real row, but the key it needs isn't reachable --
 *  a stale credentialId, or no credential and no provider fallback env var
 *  set. Distinct from LLMConfigNotFoundError (no row found at all) so a
 *  route can log which failure mode actually happened. */
export class LLMCredentialMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LLMCredentialMissingError";
  }
}

/** A config resolved to a real row with a real key, but this deployment has
 *  no client factory for its provider yet. "openrouter" and "llmoxie" (#178,
 *  UW SSEC's LiteLLM gateway) both do; openai/anthropic/claude_for_education/
 *  local remain graceful stubs, matching the issue's own "if provider=local,
 *  handle gracefully (stub/error for now)" guidance -- never a silent
 *  misroute to a different provider than what the config says. */
export class UnsupportedLLMProviderError extends Error {
  constructor(readonly provider: string) {
    super(`LLM provider "${provider}" is not yet supported by this deployment`);
    this.name = "UnsupportedLLMProviderError";
  }
}

export interface ResolvedLLMConfig {
  id: string;
  provider: LlmProvider;
  modelName: string;
  temperature: number;
  maxCompletionTokens: number;
  credentialId: string | null;
  /** #364: the one configured failover hop, or null. Read as part of this
   *  same projection rather than by a second query, so the primary's own
   *  resolution already carries everything `resolveFallbackLLMConfig` needs
   *  to decide whether a failover is even possible for this turn. */
  fallbackLlmConfigId: string | null;
  /** #365: the config's own stored system prompt. The CHAT path deliberately
   *  ignores this -- #317 replaced it with `assembleSystemPrompt` +
   *  `prompt_templates` resolution (see chat.ts's own header) -- but the
   *  config-test route (routes/llmConfigs.ts) exercises "the config exactly
   *  as saved", which includes this column. Carried on this shape so that
   *  route can resolve provider, credential AND prompt from the one
   *  canonical loader instead of a second read of the same row. */
  basePrompt: string;
  /** #317 review, #349: this config's own $/1M-token rates, if an operator
   *  has set them -- estimateCostCents prefers these over its built-in
   *  static table. Both null unless both columns are set (see the schema
   *  column's own doc comment for why a half-known rate isn't used). */
  pricePerMillionInputTokens: number | null;
  pricePerMillionOutputTokens: number | null;
  /** #168: per-config override of the markSectionComplete stopping-rule
   *  wording -- see llm_configs.markCompleteInstruction's own doc comment
   *  (db/schema/content.ts). Null (the common case) means "use
   *  lib/prompts.ts's DEFAULT_MARK_COMPLETE_INSTRUCTION" -- chat.ts's own
   *  call site does that `?? DEFAULT_MARK_COMPLETE_INSTRUCTION` fallback,
   *  not this module, so this stays a plain passthrough of the column. */
  markCompleteInstruction: string | null;
}

const LLM_CONFIG_COLUMNS = {
  id: llmConfigs.id,
  provider: llmConfigs.provider,
  modelName: llmConfigs.modelName,
  temperature: llmConfigs.temperature,
  maxCompletionTokens: llmConfigs.maxCompletionTokens,
  pricePerMillionInputTokens: llmConfigs.pricePerMillionInputTokens,
  pricePerMillionOutputTokens: llmConfigs.pricePerMillionOutputTokens,
  markCompleteInstruction: llmConfigs.markCompleteInstruction,
  credentialId: llmConfigs.credentialId,
  fallbackLlmConfigId: llmConfigs.fallbackLlmConfigId,
  basePrompt: llmConfigs.basePrompt,
} as const;

/** #364: the single "load THIS config row, under THIS org" primitive. Every
 *  by-id config read in the application goes through it -- `resolveLLMConfig`'s
 *  homework and course override branches below, `resolveFallbackLLMConfig`'s
 *  failover hop, and routes/llmConfigs.ts's test button (#365) -- so the org
 *  scoping, the column projection, and the active-row rule each have exactly
 *  one implementation rather than one per call site.
 *
 *  `activeOnly` defaults to true, matching every resolution caller: an
 *  instructor who deactivated a config has said it should not serve traffic,
 *  so a homework/course/fallback pointing at a deactivated row resolves as if
 *  it pointed at nothing. The config-test route passes false -- testing a
 *  retired config before reactivating it is exactly what that button is for,
 *  and it serves no student traffic.
 *
 *  Returns null for "no such id" and "belongs to another organization"
 *  indistinguishably; the org predicate is in the same WHERE clause as the id,
 *  so a cross-tenant row cannot be read even to learn that it exists.
 *
 *  Distinct from repositories/llmConfigs.ts's `getLlmConfig`, which returns
 *  the admin-console `LlmConfigRecord` -- that shape is the wire contract
 *  apps/admin reads (its `_RecordMatchesWire` guard enforces both
 *  directions), and it deliberately carries no `credentialId`: which secret
 *  backs a config is not something the console renders, and adding it there
 *  to serve routes/llmConfigs.ts's Test button would push a server-only
 *  field into the public payload. Reusing LLM_CONFIG_COLUMNS here is also
 *  what keeps that button from drifting from the chat path -- two
 *  hand-maintained column lists would be exactly how #365 came back.
 *
 *  #390 (staging PR #382's own follow-up): because this one read carries
 *  provider, credentialId, modelName, basePrompt, temperature AND
 *  maxCompletionTokens, a caller never has to pair it with a second read of
 *  the same row, so there is no window in which an admin's edit lands
 *  between the two and the request runs a hybrid of old and new config. Any
 *  new by-id call site should take everything it needs from ONE call here
 *  rather than reaching for `getLlmConfig` alongside it. */
export async function loadLLMConfigById(
  db: Db,
  orgScope: OrgScope,
  id: string,
  opts?: { activeOnly?: boolean },
): Promise<ResolvedLLMConfig | null> {
  const activeOnly = opts?.activeOnly ?? true;
  const [row] = await db
    .select(LLM_CONFIG_COLUMNS)
    .from(llmConfigs)
    .where(
      and(
        eq(llmConfigs.id, id),
        eq(llmConfigs.organizationId, orgScope),
        ...(activeOnly ? [eq(llmConfigs.isActive, true)] : []),
      ),
    );
  return row ?? null;
}

/** Homework's `llm_config_id` if set (and still active) -> the course's
 *  `llm_config_id` if set (and still active) -> the org's
 *  `is_default && is_active` config -> LLMConfigNotFoundError. Three levels,
 *  matching the three override/default columns the schema actually has
 *  (#317 review, #325: `courses.llmConfigId` closes the course-level gap
 *  this doc comment used to call out as missing -- lets one course under a
 *  shared org, e.g. one of the four CDI projects, pin its own model without
 *  setting `llm_config_id` on every homework in it).
 *
 *  `homeworkLlmConfigId` -- #317 review, #326: the caller's job now, not
 *  this function's -- passes the homework's `llm_config_id` column value
 *  directly (null for "no override" or "tutor-kind, no homework at all"),
 *  instead of a homeworkId this function re-reads `homeworks` with. Every
 *  real caller (chat.ts) already has this column from a join it ran one
 *  statement earlier (getSectionPromptContext, lib/prompts.ts) to fetch
 *  the section/homework title text -- re-reading `homeworks` here was a
 *  second Neon HTTP round-trip for a column the caller already had.
 *
 *  `courseLlmConfigId` -- #317 review, #346: same idiom, one level up.
 *  Undefined (the default) means "the caller doesn't have this for free,
 *  look it up here" -- chat.ts's two conversation-creation branches, which
 *  don't get a `courses` row from an earlier join. Any other value
 *  (including explicit null, "the course has no override") means the
 *  caller already resolved it -- chat.ts's dominant existing-conversation
 *  path gets it from the same getConversationById join `resolveConversation`
 *  already runs, and this function trusts that instead of re-reading
 *  `courses` for a row the caller already has. */
export async function resolveLLMConfig(
  db: Db,
  orgScope: OrgScope,
  courseScope: CourseScope,
  homeworkLlmConfigId: string | null,
  courseLlmConfigId?: string | null,
): Promise<ResolvedLLMConfig> {
  if (homeworkLlmConfigId) {
    const override = await loadLLMConfigById(db, orgScope, homeworkLlmConfigId);
    if (override) return override;
  }

  const resolvedCourseLlmConfigId =
    courseLlmConfigId !== undefined
      ? courseLlmConfigId
      : ((await db.select({ llmConfigId: courses.llmConfigId }).from(courses).where(eq(courses.id, courseScope)))[0]
          ?.llmConfigId ?? null);
  if (resolvedCourseLlmConfigId) {
    const courseOverride = await loadLLMConfigById(db, orgScope, resolvedCourseLlmConfigId);
    if (courseOverride) return courseOverride;
  }

  const [orgDefault] = await db
    .select(LLM_CONFIG_COLUMNS)
    .from(llmConfigs)
    .where(
      and(eq(llmConfigs.organizationId, orgScope), eq(llmConfigs.isDefault, true), eq(llmConfigs.isActive, true)),
    );
  if (orgDefault) return orgDefault;

  // #317 review, #351 (requirement, "make the invariant structural"):
  // migration 0029 backfills every org missing a default config, but only
  // orgs that exist AT MIGRATE TIME -- nothing enforces this afterwards
  // (no column default, no constraint, no application code path that
  // creates an organization at all). Onboarding a second tenant post-deploy
  // left every one of its students getting a 500 on every message, with
  // nothing in the symptom pointing at "the org was never given a config."
  // Auto-provisions instead of just throwing, so the invariant holds for
  // every org this function is ever called for, not only the ones that
  // happened to exist when 0029 ran.
  return ensurePlatformDefaultLLMConfig(db, orgScope);
}

/** Provider/model this deployment falls back to for an org with no default
 *  config at all -- deliberately the same values migration 0029's own
 *  backfill and scripts/seed.ts use, so a freshly-provisioned org and a
 *  freshly-migrated one land on identical behavior. */
const PLATFORM_DEFAULT_PROVIDER: LlmProvider = "llmoxie";
const PLATFORM_DEFAULT_MODEL_NAME = "gpt-5.3-codex";

/** Auto-provisions an org's default llm_configs row the first time
 *  resolveLLMConfig finds none, instead of throwing LLMConfigNotFoundError
 *  -- a real row with a real id, not a synthetic in-memory config: every
 *  downstream consumer (llm_call_logs.llm_config_id's FK, the write-back
 *  paths in chat.ts) expects `ResolvedLLMConfig.id` to reference an actual
 *  row, so nothing here can fabricate one.
 *
 *  Race-safe: two concurrent first turns for a brand-new org (two students'
 *  opening messages arriving close together) both reach this function.
 *  `onConflictDoNothing` targets `llm_configs_org_default_uq` (a PARTIAL
 *  unique index on organizationId WHERE isDefault = true -- the `where`
 *  clause here has to match it exactly for Postgres to treat this as the
 *  same conflict target), so exactly one INSERT wins; the loser's insert
 *  silently no-ops, and both callers then read back the SAME winning row.
 *
 *  Deliberately does NOT fire when an org already has an is_default=true
 *  row that is merely inactive (an admin deactivated it without picking a
 *  replacement): the INSERT still conflicts against that row (the unique
 *  index applies regardless of isActive, same fact #348's migration 0031
 *  fix already relies on), so the re-select below finds nothing and this
 *  throws LLMConfigNotFoundError same as before -- an intentional admin
 *  action staying a real error, not something the platform silently papers
 *  over by activating a config nobody chose. */
async function ensurePlatformDefaultLLMConfig(db: Db, orgScope: OrgScope): Promise<ResolvedLLMConfig> {
  await db
    .insert(llmConfigs)
    .values({
      organizationId: orgScope,
      // #317/#363 merge: llm_configs.name arrives NOT NULL in migration
      // 0040, which backfills every pre-existing row with its own
      // model_name. Matching that convention here keeps this function's
      // stated invariant intact -- a freshly auto-provisioned org and a
      // freshly migrated one land on an identical row, name included --
      // rather than inventing a second naming scheme for the same config.
      // An instructor renames it from the console.
      name: PLATFORM_DEFAULT_MODEL_NAME,
      provider: PLATFORM_DEFAULT_PROVIDER,
      modelName: PLATFORM_DEFAULT_MODEL_NAME,
      isDefault: true,
      isActive: true,
    })
    .onConflictDoNothing({ target: llmConfigs.organizationId, where: eq(llmConfigs.isDefault, true) });

  const [row] = await db
    .select(LLM_CONFIG_COLUMNS)
    .from(llmConfigs)
    .where(
      and(eq(llmConfigs.organizationId, orgScope), eq(llmConfigs.isDefault, true), eq(llmConfigs.isActive, true)),
    );
  if (!row) throw new LLMConfigNotFoundError();
  return row;
}

/** #364/#98: the one configured failover hop for a config, or null.
 *
 *  DESIGN DECISION (the open fork #364 left to whoever implemented it):
 *  **a direct read of `fallback_llm_config_id`, through the shared
 *  `loadLLMConfigById` primitive above -- NOT `resolveLLMConfig` called with
 *  the fallback id as its `homeworkLlmConfigId` entry point.**
 *
 *  That reuse looks natural (resolveLLMConfig's first branch IS a by-id,
 *  org-scoped, active-only read) and was the issue's own leaning, but it is
 *  wrong here for three independent reasons, in descending severity:
 *
 *   1. It cannot fail. resolveLLMConfig's contract is "always produce a
 *      usable config", so a fallback id that no longer resolves -- retired,
 *      deleted, moved org -- falls THROUGH to the course override and then
 *      the org default. The org default is what the great majority of
 *      conversations resolve their PRIMARY to, so a failover would routinely
 *      retry the exact model that just failed: a second paid call, doubled
 *      latency before the student sees the error, and a log line naming the
 *      "fallback" for a fault that was never anyone else's. A failover path
 *      must be able to answer "there is no fallback" (-> null, rethrow the
 *      primary's error, today's behaviour exactly), and resolveLLMConfig
 *      structurally cannot.
 *   2. It writes. The no-default tail calls ensurePlatformDefaultLLMConfig,
 *      which INSERTs a row. Auto-provisioning an org's default config is
 *      correct on a first turn; doing it from inside an error path, while a
 *      provider outage is in progress, is not -- an error handler must not
 *      have a side effect the happy path doesn't.
 *   3. It re-walks. homework -> course -> org, for a config id already
 *      known, is up to two extra Neon round-trips added to a turn that has
 *      already spent one failed provider call.
 *
 *  So: one hop, read directly, never a walk. `fallbackLlmConfigId` on the
 *  FALLBACK is deliberately not consulted, which is what makes depth-one safe
 *  without cycle detection -- there is no traversal to loop -- and the
 *  schema's `llm_configs_fallback_not_self_chk` closes the degenerate case.
 *
 *  A deactivated fallback resolves to null (loadLLMConfigById's active-only
 *  default): an instructor who retired a config said it should not serve
 *  traffic, and "except when the primary is down" is not something they said.
 *
 *  CONVERSATION-STABILITY INVARIANT (#30): this is derived from the PRIMARY
 *  config's own row, per turn, and is never written back to the conversation
 *  or consulted on a later turn. It therefore inherits whatever stability the
 *  primary resolution has and adds no new re-resolution of its own -- a
 *  failover changes which model serves ONE turn, never which config the
 *  conversation is on. */
export async function resolveFallbackLLMConfig(
  db: Db,
  orgScope: OrgScope,
  primary: Pick<ResolvedLLMConfig, "fallbackLlmConfigId">,
): Promise<ResolvedLLMConfig | null> {
  if (!primary.fallbackLlmConfigId) return null;
  return loadLLMConfigById(db, orgScope, primary.fallbackLlmConfigId);
}

/** Provider -> the conventional Worker-secret binding name used when a
 *  config has no linked credential row -- the same convention
 *  OPENROUTER_API_KEY already used before this issue, and #178's
 *  LLMOXIE_API_KEY too. Most configs won't have a credential row until
 *  an admin credential-management UI exists (not built yet); this fallback
 *  is what keeps an org-default config created without one still usable. */
const PROVIDER_FALLBACK_ENV_VAR: Partial<Record<LlmProvider, string>> = {
  openrouter: "OPENROUTER_API_KEY",
  llmoxie: "LLMOXIE_API_KEY",
};

/** #343: the same map, exported read-only so an operator-facing error can
 *  name the exact binding to provision without this module's internals
 *  leaking further. */
export const PROVIDER_FALLBACK_ENV_VAR_NAME: Readonly<Partial<Record<LlmProvider, string>>> =
  PROVIDER_FALLBACK_ENV_VAR;

/** #343: which provider takes over when a platform provider's own credential
 *  is unavailable. Only llmoxie has one -- openrouter IS the fallback, and a
 *  cycle would be a hang rather than a degradation. See
 *  resolveProviderCredential for why this is opt-in on a model binding. */
const PROVIDER_DEGRADATION: Partial<Record<LlmProvider, { provider: LlmProvider }>> = {
  llmoxie: { provider: "openrouter" },
};

/** #317 review, security finding #323: organization_credentials.secretRef
 *  is free-form `text`, entirely DB-controlled -- with no allowlist, it was
 *  used as an unrestricted index into the whole Worker secret environment
 *  (ENCRYPTION_KEY, BLIND_INDEX_KEY, SESSION_SECRET, DATABASE_URL,
 *  WORKOS_API_KEY all live in the same `env`). Not exploitable today (no
 *  write path to organization_credentials exists yet), but becomes Critical
 *  the day a credential-management UI ships: one write of
 *  secret_ref = "ENCRYPTION_KEY" would transmit the PII encryption key to
 *  openrouter.ai as a Bearer token on the next chat turn. Every legitimate
 *  binding this app resolves a secret from is named here; anything else is
 *  refused before it ever reaches env lookup. */
const ALLOWED_SECRET_REF_BINDINGS: ReadonlySet<string> = new Set(
  Object.values(PROVIDER_FALLBACK_ENV_VAR),
);

/** The one place this module reads an env binding by a name that isn't a
 *  compile-time-known property access -- confined to this single line
 *  (rather than the whole `env` object being cast at the call site, as it
 *  was before this fix) so `Env` stays fully type-checked everywhere else a
 *  caller touches it. Every call site either passes a name from
 *  PROVIDER_FALLBACK_ENV_VAR (a hardcoded map this module owns, not
 *  DB-controlled) or one ALLOWED_SECRET_REF_BINDINGS has already
 *  validated. */
function readEnvSecret(env: Env, bindingName: string): string | undefined {
  return (env as unknown as Record<string, string | undefined>)[bindingName];
}

/** Resolves the actual API key for a config -- from its linked
 *  `organization_credentials.secretRef` (an env-binding name; `secretRef`
 *  itself is never the secret, per that table's own column comment) if one
 *  is set, else the provider's conventional fallback env var above. Reads
 *  the key into a local variable only, at the moment of use -- callers must
 *  not log or persist it (see chat.ts's call site). */
/** #343: the one documented degradation from the platform gateway.
 *
 *  Migration 0035 makes `llmoxie` every org's default provider with no
 *  credential row, so key resolution goes to LLMOXIE_API_KEY. If that binding
 *  is missing on a deploy target, resolveApiKey throws and chat.ts returns
 *  500 -- for every student, in every org, on every turn. Rolling the Worker
 *  back does not help, because the DB rows are already flipped; recovery
 *  needs a manual UPDATE. #343 asked for a degradation so a missing platform
 *  credential is an outage for nobody rather than for everyone.
 *
 *  The subtlety that makes this more than a key swap: a provider's key is
 *  useless against another provider's endpoint, and model IDs are not
 *  portable either -- 0035's default is `gpt-5.3-codex`, which is an LLMoxie
 *  catalogue name, not an OpenRouter slug. Handing an OpenRouter key to the
 *  LLMoxie gateway, or an LLMoxie model name to OpenRouter, both fail worse
 *  than the honest 500 they replaced. So provider, key and model degrade
 *  together or not at all.
 *
 *  NAMED `LLM_DEGRADED_MODEL`, not `..._FALLBACK_MODEL` (#431): "fallback"
 *  is #364's instructor-configured, per-config, stream-level failover
 *  (`llm_configs.fallback_llm_config_id`). This is the operator's
 *  credential-time degradation. Two mechanisms sharing one word in their
 *  vocabulary is how the two stop being distinguishable in review.
 *
 *  OPT-IN by design: this engages only when an operator has set
 *  LLM_DEGRADED_MODEL to a model their OpenRouter account can
 *  actually serve. There is no default, deliberately -- guessing a slug here
 *  would trade a loud, diagnosable failure for a silent one against a model
 *  nobody chose, with its own pricing. Unset, behaviour is exactly as before.
 */
export interface ResolvedProviderCredential {
  provider: LlmProvider;
  apiKey: string;
  modelName: string;
  /** Set only when degradation actually fired -- the provider the config
   *  asked for. Callers log it; chat.ts also records it on the call log so a
   *  degraded turn is distinguishable after the fact. */
  degradedFrom?: LlmProvider;
}

export async function resolveProviderCredential(
  env: Env,
  db: Db,
  orgScope: OrgScope,
  config: ResolvedLLMConfig,
): Promise<ResolvedProviderCredential> {
  try {
    const apiKey = await resolveApiKey(env, db, orgScope, config);
    return { provider: config.provider, apiKey, modelName: config.modelName };
  } catch (err) {
    if (!(err instanceof LLMCredentialMissingError)) throw err;

    /* Only the platform-gateway-with-no-credential case degrades. A config
       with its own credentialId named a specific secret and it is missing or
       not allowlisted -- that is a misconfiguration of THAT org's own
       credential, and silently serving it from the platform's OpenRouter key
       would bill the wrong account and hide the mistake. */
    const degradation = config.credentialId === null ? PROVIDER_DEGRADATION[config.provider] : undefined;
    if (!degradation) throw err;

    const fallbackModel = env.LLM_DEGRADED_MODEL;
    if (!fallbackModel) throw err;

    const fallbackVar = PROVIDER_FALLBACK_ENV_VAR[degradation.provider];
    const apiKey = fallbackVar ? readEnvSecret(env, fallbackVar) : undefined;
    if (!apiKey) throw err;

    return {
      provider: degradation.provider,
      apiKey,
      modelName: fallbackModel,
      degradedFrom: config.provider,
    };
  }
}

export async function resolveApiKey(
  env: Env,
  db: Db,
  orgScope: OrgScope,
  config: ResolvedLLMConfig,
): Promise<string> {
  if (config.credentialId) {
    const [credential] = await db
      .select({ secretRef: organizationCredentials.secretRef })
      .from(organizationCredentials)
      .where(
        and(
          eq(organizationCredentials.id, config.credentialId),
          eq(organizationCredentials.organizationId, orgScope),
        ),
      );
    if (!credential) {
      throw new LLMCredentialMissingError(
        `llm_configs ${config.id} references a credential that no longer exists or belongs to a different org`,
      );
    }
    if (!ALLOWED_SECRET_REF_BINDINGS.has(credential.secretRef)) {
      throw new LLMCredentialMissingError(
        `Secret binding "${credential.secretRef}" is not on the allowlist of env bindings this deployment may resolve a credential from`,
      );
    }
    const key = readEnvSecret(env, credential.secretRef);
    if (!key) {
      throw new LLMCredentialMissingError(`Secret "${credential.secretRef}" is not set in this environment`);
    }
    return key;
  }

  const fallbackVar = PROVIDER_FALLBACK_ENV_VAR[config.provider];
  const key = fallbackVar ? readEnvSecret(env, fallbackVar) : undefined;
  if (!key) {
    // #317 review, #343: names the actual binding (or "(none)" when this
    // provider has no fallback mapped at all) instead of a generic "no
    // fallback env var is set" -- an operator debugging a 500 needs to know
    // which secret is missing without reading this module's source.
    throw new LLMCredentialMissingError(
      `No credential configured for llm_configs ${config.id} (provider "${config.provider}") and fallback env var ${fallbackVar ?? "(none)"} is not set`,
    );
  }
  return key;
}

/** #317 review, #325 ("selectable != working"): the subset of `llm_provider`
 *  buildProviderClient below actually has a factory for. `llm_provider` has
 *  five values; only these two work. routes/llmConfigs.ts's picker route
 *  filters to this set so an instructor authoring a homework cannot select
 *  a config that 500s on its first real turn -- this is the single source
 *  of truth both that route and buildProviderClient's own branches read
 *  from, so a new provider case can't add one without the other. */
export const SUPPORTED_LLM_PROVIDERS: ReadonlySet<LlmProvider> = new Set(["openrouter", "llmoxie"]);

/** The per-request provider client factory -- #178 added the "llmoxie"
 *  case beside "openrouter" rather than in place of it, so existing
 *  openrouter-provider configs keep working unchanged. */
export function buildProviderClient(
  provider: LlmProvider,
  apiKey: string,
  /** Deployment-varying endpoints. Optional so existing callers are
   *  unchanged and an unset binding keeps the previous behaviour. */
  endpoints?: { llmoxieBaseUrl?: string },
) {
  if (provider === "openrouter") return getOpenRouter(apiKey);
  if (provider === "llmoxie") return getLLMoxie(apiKey, endpoints?.llmoxieBaseUrl);
  throw new UnsupportedLLMProviderError(provider);
}

/** #317 review, #321: built-in per-model $/1M-token rates for
 *  llm_call_logs.cost_cents (the CDI reporting story) -- the fallback
 *  estimateCostCents uses when a config has no per-config rate of its own
 *  (llm_configs.pricePerMillionInputTokens/OutputTokens, #349). Best-effort
 *  and explicitly approximate -- neither the AI SDK nor this app's schema
 *  tracks a canonical price list, and OpenRouter alone fronts hundreds of
 *  models with independently-set rates that change over time. Add a
 *  model's real published rate here (as a deployment-wide default) or set
 *  it per-config in llm_configs when it's confirmed; an unlisted, unset
 *  model resolves to a null cost (an honest "unknown," not a guessed
 *  number) rather than silently defaulting to $0 or some other model's
 *  rate.
 *
 *  #317 review, #349: this table was previously unreachable in practice --
 *  its only entry was the ":free" model estimateCostCents already
 *  short-circuits on before ever consulting the table, and no other entry
 *  existed. `gpt-5.3-codex` (the #340/scripts/seed.ts default model, routed
 *  through UW SSEC's own LLMOxie/LiteLLM gateway) is deliberately NOT
 *  listed here: that gateway's actual per-org billing arrangement is not
 *  public, institution-specific data this codebase has any source of
 *  truth for, and a guessed number would be actively worse than the
 *  honest null this function already returns for an unknown model --
 *  exactly the failure mode this table's own philosophy exists to avoid.
 *  Set it via llm_configs.pricePerMillionInputTokens/OutputTokens (or add
 *  a real confirmed rate here) once that figure is known. */
const MODEL_PRICING_PER_MILLION_TOKENS: Record<string, { input: number; output: number }> = {
  "google/gemma-4-31b-it:free": { input: 0, output: 0 },
};

/** Returns null (not 0) for a model with no known rate -- see the pricing
 *  table's own doc comment for why guessing would be worse than omitting.
 *  Rounds to the nearest cent; a single turn's cost is expected to be a
 *  small fraction of a cent for most models, so this is aggregated cost
 *  reporting, not a per-turn billing primitive.
 *
 *  #317 review, #349: `configuredPricing` (the resolved config's own
 *  pricePerMillionInputTokens/OutputTokens) takes precedence over the
 *  built-in static table when BOTH its fields are set -- a per-tenant,
 *  no-redeploy-needed rate for a model this table doesn't (or can't, see
 *  its own doc comment) list. Only one of the two must be non-null to
 *  count as "not configured": a half-set rate isn't a half-known cost. */
export function estimateCostCents(
  modelName: string,
  inputTokens: number | null,
  outputTokens: number | null,
  configuredPricing?: { input: number | null; output: number | null } | null,
): number | null {
  if (modelName.endsWith(":free")) return 0;
  const pricing =
    configuredPricing?.input != null && configuredPricing?.output != null
      ? { input: configuredPricing.input, output: configuredPricing.output }
      : MODEL_PRICING_PER_MILLION_TOKENS[modelName];
  if (!pricing || inputTokens === null || outputTokens === null) return null;
  const dollars = (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
  return Math.round(dollars * 100);
}
