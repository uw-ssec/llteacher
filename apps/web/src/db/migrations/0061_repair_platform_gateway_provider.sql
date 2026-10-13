-- The instructor console labels its only enabled provider option "Platform
-- gateway", but its save adapter incorrectly persisted that option as
-- openrouter. The same form obtains unprefixed model aliases from LLMoxie's
-- /models endpoint, leaving rows such as openrouter/gpt-5.3-codex that no
-- provider can serve as configured.
--
-- OpenRouter's canonical model ids are vendor/model slugs. Restricting this
-- repair to unprefixed ids with no organization credential fixes rows created
-- by the platform UI without changing valid OpenRouter configurations or an
-- operator-managed credential override.
UPDATE "llm_configs"
SET "provider" = 'llmoxie'
WHERE "provider" = 'openrouter'
  AND "credential_id" IS NULL
  AND position('/' IN "model_name") = 0;
