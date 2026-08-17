-- #333 follow-up: the platform default should point at the LLMoxie gateway
-- (a platform-held credential, not an instructor's own key) rather than the
-- OPENROUTER_API_KEY-backed openrouter/gemma row migration 0029 backfilled.
-- credential_id stays NULL: resolveApiKey falls back to LLMOXIE_API_KEY for
-- provider='llmoxie' with no credentialId, mirroring 0029's openrouter case.
--
-- Scoped to rows that still match 0029's exact backfill values, so a config
-- an org has since edited away from the seed default is left alone.
UPDATE llm_configs
SET provider = 'llmoxie', model_name = 'gpt-5.3-codex'
WHERE is_default = true
  AND provider = 'openrouter'
  AND model_name = 'google/gemma-4-31b-it:free'
  AND credential_id IS NULL;
