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
 *  LLMOXIE_API_KEY will too. Most configs won't have a credential row until
 *  an admin credential-management UI exists (not built yet); this fallback
 *  is what keeps an org-default config created without one still usable. */
const PROVIDER_FALLBACK_ENV_VAR: Partial<Record<LlmProvider, string>> = {
  openrouter: "OPENROUTER_API_KEY",
  llmoxie: "LLMOXIE_API_KEY",
};

/** Resolves the actual API key for a config -- from its linked
 *  `organization_credentials.secretRef` (an env-binding name; `secretRef`
 *  itself is never the secret, per that table's own column comment) if one
 *  is set, else the provider's conventional fallback env var above. Reads
 *  the key into a local variable only, at the moment of use -- callers must
 *  not log or persist it (see chat.ts's call site). */
export async function resolveApiKey(
  env: Record<string, string | undefined>,
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
    const key = env[credential.secretRef];
    if (!key) {
      throw new LLMCredentialMissingError(`Secret "${credential.secretRef}" is not set in this environment`);
    }
    return key;
  }

  const fallbackVar = PROVIDER_FALLBACK_ENV_VAR[config.provider];
  const key = fallbackVar ? env[fallbackVar] : undefined;
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
