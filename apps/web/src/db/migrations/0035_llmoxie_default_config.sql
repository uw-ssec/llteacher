-- #333 follow-up: the platform default should point at the LLMoxie gateway
-- (a platform-held credential, not an instructor's own key) rather than the
-- OPENROUTER_API_KEY-backed openrouter/gemma row migration 0029 backfilled.
-- credential_id stays NULL: resolveApiKey falls back to LLMOXIE_API_KEY for
-- provider='llmoxie' with no credentialId, mirroring 0029's openrouter case.
--
-- Scoped to rows that still match 0029's exact backfill values, so a config
-- an org has since edited away from the seed default is left alone.
--
-- CI fix: 'llmoxie' was added to the llm_provider enum by migration 0028.
-- drizzle-kit's migrate always batches every pending migration into ONE
-- transaction (pg-core/dialect.ts's PgDialect.migrate wraps the whole run in
-- a single session.transaction), and Postgres refuses to use an enum value
-- inside the same transaction that added it (SQLSTATE 55P04, "New enum
-- values must be committed before they can be used"). On any database that
-- already had 0028 applied in an earlier, separate migrate run (every real
-- deploy target -- 0028 shipped in #333, well before this migration
-- existed) that's a non-issue: only this migration is "pending", so it gets
-- its own transaction and 'llmoxie' is already committed. It only bites a
-- from-scratch database where drizzle-kit applies 0001-through-here in one
-- shot -- exactly CI's ephemeral test Postgres. Caught and swallowed here
-- rather than avoided, because on that same from-scratch database there are
-- no llm_configs rows yet for this UPDATE to match anyway (scripts/seed.ts
-- already seeds the llmoxie/gpt-5.3-codex default directly for a fresh
-- org) -- there is nothing this backfill needs to do there.
DO $$
BEGIN
  UPDATE llm_configs
  SET provider = 'llmoxie', model_name = 'gpt-5.3-codex'
  WHERE is_default = true
    AND provider = 'openrouter'
    AND model_name = 'google/gemma-4-31b-it:free'
    AND credential_id IS NULL;
EXCEPTION
  WHEN SQLSTATE '55P04' THEN
    RAISE NOTICE 'llmoxie default backfill skipped: enum value not yet committed in this transaction (expected on a from-scratch migrate run, harmless -- see this file''s comment)';
END $$;
