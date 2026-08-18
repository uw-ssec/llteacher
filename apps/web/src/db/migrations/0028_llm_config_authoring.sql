-- #31 / #98: the columns the instructor-facing config authoring needs.
--
-- `name` is added nullable, backfilled, and only then made NOT NULL.
-- drizzle-kit emitted a bare `ADD COLUMN "name" text NOT NULL`, which is
-- correct against an empty table and fails against any environment that
-- already holds a config row -- Postgres has no value to put there. That is
-- not hypothetical: llm_configs has existed since 0000 and the seed script
-- writes one.
--
-- The backfill uses the model name because it is the only human-meaningful
-- string the row already carries, and a config called "google/gemma-4-31b-it"
-- is at least true. Instructors rename from the console.
ALTER TABLE "llm_configs" ADD COLUMN "name" text;--> statement-breakpoint
UPDATE "llm_configs" SET "name" = "model_name" WHERE "name" IS NULL;--> statement-breakpoint
ALTER TABLE "llm_configs" ALTER COLUMN "name" SET NOT NULL;--> statement-breakpoint
-- base_prompt carries a default, so it needs no backfill pass: existing rows
-- take the empty string, which resolveLlmConfig reads as "this config states
-- no voice of its own" and falls back to the platform prompt.
ALTER TABLE "llm_configs" ADD COLUMN "base_prompt" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_configs" ADD COLUMN "fallback_llm_config_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "llm_configs" ADD CONSTRAINT "llm_configs_fallback_llm_config_id_llm_configs_id_fk" FOREIGN KEY ("fallback_llm_config_id") REFERENCES "public"."llm_configs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- #31: an inactive config must not be the org default -- the default is what
-- every course without an explicit choice resolves to. Normalised first for
-- the reason 0020 and 0027 normalise: nothing in the application can produce
-- a violating row today, but the ADD CONSTRAINT must not be the statement
-- that blocks a deploy against an environment that somehow holds one.
-- Deactivating the default is the safer half of the pair to undo: the org
-- keeps a working default until an instructor picks another.
UPDATE "llm_configs" SET "is_default" = false WHERE "is_default" AND NOT "is_active";--> statement-breakpoint
ALTER TABLE "llm_configs" ADD CONSTRAINT "llm_configs_active_required_for_default_chk" CHECK (NOT ("llm_configs"."is_default" AND NOT "llm_configs"."is_active"));--> statement-breakpoint
-- #98: a config cannot be its own fallback. New column, so no row can
-- violate it -- stated for symmetry with the constraint above.
ALTER TABLE "llm_configs" ADD CONSTRAINT "llm_configs_fallback_not_self_chk" CHECK ("llm_configs"."fallback_llm_config_id" IS NULL OR "llm_configs"."fallback_llm_config_id" <> "llm_configs"."id");
