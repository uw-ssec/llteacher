-- #333 follow-up: the platform default should point at the LLMoxie gateway
-- (a platform-held credential, not an instructor's own key) rather than the
-- OPENROUTER_API_KEY-backed openrouter/gemma row migration 0029 backfilled.
-- credential_id stays NULL: resolveApiKey falls back to LLMOXIE_API_KEY for
-- provider='llmoxie' with no credentialId, mirroring 0029's openrouter case.
--
-- Scoped to rows that still match 0029's exact backfill values, so a config
-- an org has since edited away from the seed default is left alone.
--
-- #340: 'llmoxie' was added to the llm_provider enum by migration 0028, and
-- Postgres refuses to use an enum value inside the same transaction that
-- added it (SQLSTATE 55P04, "New enum values must be committed before they
-- can be used"). scripts/migrate.ts (not raw `drizzle-kit migrate`, see its
-- own doc comment) is what makes this UPDATE safe in the normal case: it
-- applies every migration BEFORE this one in its own transaction first, so
-- 'llmoxie' is durably committed by the time this file runs in its own,
-- second transaction.
--
-- The EXCEPTION handler below is a safety net for the abnormal case, not
-- the primary mechanism -- someone running raw `drizzle-kit migrate`
-- directly against a from-scratch database, bypassing scripts/migrate.ts,
-- bundles 0028 and this file into one transaction again. On a genuinely
-- fresh database there's nothing for this UPDATE to do anyway (no
-- llm_configs rows exist yet; scripts/seed.ts already seeds the
-- llmoxie/gpt-5.3-codex default directly for a new org), so a real no-op
-- there is correct. What must NEVER happen again is a *populated* database
-- silently keeping every org on openrouter/gemma while `db:migrate` exits 0
-- and looks like it worked (#340's whole finding) -- so the handler
-- recounts the same predicate using ONLY the pre-existing 'openrouter'
-- literal (safe: that value has been in the enum since 0001, not added in
-- this transaction) and aborts loudly if it finds real rows this UPDATE
-- should have touched.
DO $$
DECLARE
  pending_backfill_count integer;
BEGIN
  UPDATE llm_configs
  SET provider = 'llmoxie', model_name = 'gpt-5.3-codex'
  WHERE is_default = true
    AND provider = 'openrouter'
    AND model_name = 'google/gemma-4-31b-it:free'
    AND credential_id IS NULL;
EXCEPTION
  WHEN SQLSTATE '55P04' THEN
    SELECT count(*) INTO pending_backfill_count
    FROM llm_configs
    WHERE is_default = true
      AND provider = 'openrouter'
      AND model_name = 'google/gemma-4-31b-it:free'
      AND credential_id IS NULL;
    IF pending_backfill_count > 0 THEN
      RAISE EXCEPTION 'migration 0035: % row(s) in llm_configs need the llmoxie backfill, but ''llmoxie'' was added to llm_provider earlier in THIS SAME transaction (migration 0028), and Postgres will not let this UPDATE use it here. Run `npm run db:migrate` (scripts/migrate.ts), not `drizzle-kit migrate` directly -- it applies migrations before this one in their own transaction first, which is what makes this UPDATE safe.', pending_backfill_count;
    END IF;
    RAISE NOTICE 'llmoxie default backfill: no matching rows and the enum value is not yet committed in this transaction -- nothing to do here (expected on a from-scratch migrate run).';
END $$;
