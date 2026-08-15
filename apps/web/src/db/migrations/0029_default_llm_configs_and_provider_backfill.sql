-- PR #317 review, blocking findings #1 and #2.
--
-- #1: resolveLLMConfig (lib/llm-config.ts) throws LLMConfigNotFoundError when
-- an organization has no is_default=true llm_configs row -- and this diff
-- also removed the previous fallback (a hardcoded OPENROUTER_API_KEY secret).
-- No migration has ever inserted a default row for every org; this backfills
-- every organization currently missing one so chat doesn't 500 on deploy.
-- Value matches scripts/seed.ts's own default.
INSERT INTO llm_configs (organization_id, provider, model_name, is_default, is_active)
SELECT o.id, 'openrouter', 'google/gemma-4-31b-it:free', true, true
FROM organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM llm_configs lc WHERE lc.organization_id = o.id AND lc.is_default = true
);
--> statement-breakpoint

-- #2: buildProviderClient (lib/llm-config.ts) only has a client factory for
-- 'openrouter' and 'llmoxie' -- a provider='anthropic' row (this repo's
-- pre-#26 default) throws UnsupportedLLMProviderError the moment
-- resolveLLMConfig resolves to it. No rows currently match this in the
-- shared dev database, but this stays defensive for any other environment
-- (a local .dev.vars database seeded before this migration, a stale
-- prod/staging row) rather than assuming today's snapshot is universal.
UPDATE llm_configs
SET provider = 'openrouter', model_name = 'google/gemma-4-31b-it:free'
WHERE provider = 'anthropic';
