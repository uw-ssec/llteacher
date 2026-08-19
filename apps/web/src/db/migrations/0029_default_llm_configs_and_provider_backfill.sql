-- PR #317 review, blocking findings #1 and #2. Also #348 (non-blocking,
-- found in the same review's later re-audit): the backfill below originally
-- guarded only on `is_default = true`, but resolveLLMConfig
-- (lib/llm-config.ts) requires `is_default = true AND is_active = true`.
-- An org holding an is_default=true, is_active=false row (not reachable
-- through any writer that exists today -- scripts/seed.ts always writes
-- is_active: true, and routes/llmConfigs.ts is read-only -- but reachable
-- the moment an authoring UI can deactivate a config) would satisfy the old
-- NOT EXISTS and get no backfill row, while resolveLLMConfig still can't
-- use its existing inactive one: LLMConfigNotFoundError -> HTTP 500 on every
-- turn, exactly the outage this migration exists to prevent.
--
-- Reactivating a stale row is the only valid fix, not a second INSERT:
-- llm_configs_org_default_uq (db/schema/content.ts) is a partial unique
-- index on `organization_id WHERE is_default = true` -- it permits at most
-- one is_default=true row per org regardless of is_active, so a second
-- backfilled row for an org that already has one (even an inactive one)
-- would violate it.
UPDATE llm_configs
SET is_active = true
WHERE is_default = true AND is_active = false;
--> statement-breakpoint

-- #1: resolveLLMConfig (lib/llm-config.ts) throws LLMConfigNotFoundError when
-- an organization has no is_default=true AND is_active=true llm_configs row
-- -- and this diff also removed the previous fallback (a hardcoded
-- OPENROUTER_API_KEY secret). No migration has ever inserted a default row
-- for every org; this backfills every organization still missing a USABLE
-- one (the reactivation above already covers an org whose only problem was
-- is_active=false) so chat doesn't 500 on deploy. Value matches
-- scripts/seed.ts's own default.
INSERT INTO llm_configs (organization_id, provider, model_name, is_default, is_active)
SELECT o.id, 'openrouter', 'google/gemma-4-31b-it:free', true, true
FROM organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM llm_configs lc WHERE lc.organization_id = o.id AND lc.is_default = true AND lc.is_active = true
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
