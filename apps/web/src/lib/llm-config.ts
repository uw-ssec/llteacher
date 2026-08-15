import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { homeworks, llmConfigs, organizationCredentials } from "../db/schema";
import type { OrgScope } from "../server/repositories/scope";
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
}

const LLM_CONFIG_COLUMNS = {
  id: llmConfigs.id,
  provider: llmConfigs.provider,
  modelName: llmConfigs.modelName,
  temperature: llmConfigs.temperature,
  maxCompletionTokens: llmConfigs.maxCompletionTokens,
  credentialId: llmConfigs.credentialId,
} as const;

/** Homework's `llm_config_id` if set (and still active) -> the org's
 *  `is_default && is_active` config -> LLMConfigNotFoundError. Two levels
 *  only: `homeworks.llmConfigId` and `llmConfigs.isDefault` are the only
 *  override/default columns the schema actually has -- a course-level
 *  fallback is described in this issue's own Code Framework notes, but no
 *  `courses.llmConfigId` (or equivalent) column exists to resolve it from.
 *
 *  `homeworkId` is null for tutor-kind conversations (no homework to check
 *  an override against) -- resolution goes straight to the org default,
 *  same shape as resolvePromptTemplate's `sectionId: null` case. */
export async function resolveLLMConfig(
  db: Db,
  orgScope: OrgScope,
  homeworkId: string | null,
): Promise<ResolvedLLMConfig> {
  if (homeworkId) {
    const [homework] = await db
      .select({ llmConfigId: homeworks.llmConfigId })
      .from(homeworks)
      .where(eq(homeworks.id, homeworkId));
    if (homework?.llmConfigId) {
      const [override] = await db
        .select(LLM_CONFIG_COLUMNS)
        .from(llmConfigs)
        .where(
          and(
            eq(llmConfigs.id, homework.llmConfigId),
            eq(llmConfigs.organizationId, orgScope),
            eq(llmConfigs.isActive, true),
          ),
        );
      if (override) return override;
    }
  }

  const [orgDefault] = await db
    .select(LLM_CONFIG_COLUMNS)
    .from(llmConfigs)
    .where(
      and(eq(llmConfigs.organizationId, orgScope), eq(llmConfigs.isDefault, true), eq(llmConfigs.isActive, true)),
    );
  if (orgDefault) return orgDefault;

  throw new LLMConfigNotFoundError();
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
    throw new LLMCredentialMissingError(
      `No credential configured for llm_configs ${config.id} (provider "${config.provider}") and no fallback env var is set`,
    );
  }
  return key;
}

/** The per-request provider client factory -- #178 added the "llmoxie"
 *  case beside "openrouter" rather than in place of it, so existing
 *  openrouter-provider configs keep working unchanged. */
export function buildProviderClient(provider: LlmProvider, apiKey: string) {
  if (provider === "openrouter") return getOpenRouter(apiKey);
  if (provider === "llmoxie") return getLLMoxie(apiKey);
  throw new UnsupportedLLMProviderError(provider);
}

/** #317 review, #321: per-model $/1M-token rates for llm_call_logs.cost_cents
 *  (the CDI reporting story). Best-effort and explicitly approximate --
 *  neither the AI SDK nor this app's schema tracks a canonical price list,
 *  and OpenRouter alone fronts hundreds of models with independently-set
 *  rates that change over time. Add a model's real published rate here as
 *  it's confirmed; an unlisted model resolves to a null cost (an honest
 *  "unknown," not a guessed number) rather than silently defaulting to $0
 *  or some other model's rate. ":free" OpenRouter model slugs are the one
 *  case genuinely known to always be $0 without needing per-model upkeep. */
const MODEL_PRICING_PER_MILLION_TOKENS: Record<string, { input: number; output: number }> = {
  "google/gemma-4-31b-it:free": { input: 0, output: 0 },
};

/** Returns null (not 0) for a model with no known rate -- see the pricing
 *  table's own doc comment for why guessing would be worse than omitting.
 *  Rounds to the nearest cent; a single turn's cost is expected to be a
 *  small fraction of a cent for most models, so this is aggregated cost
 *  reporting, not a per-turn billing primitive. */
export function estimateCostCents(
  modelName: string,
  inputTokens: number | null,
  outputTokens: number | null,
): number | null {
  if (modelName.endsWith(":free")) return 0;
  const pricing = MODEL_PRICING_PER_MILLION_TOKENS[modelName];
  if (!pricing || inputTokens === null || outputTokens === null) return null;
  const dollars = (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
  return Math.round(dollars * 100);
}
