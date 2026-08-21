-- #317/#363 merge: this file is the renumbered union of what this branch
-- originally carried as 0027_ta_capability_dropped_constraint,
-- 0028_llm_config_authoring and 0029_grading_workflow. Those three numbers
-- were claimed by #317 (staging now owns 0027-0039), and their snapshots
-- chained off the pre-#317 0026, so they could not simply be renamed --
-- regenerated against the merged schema instead, then hand-restored to
-- carry the normalising prologues below. `drizzle-kit generate` emits only
-- the DDL; every UPDATE in this file is deliberate and was in the originals.

-- #207: widen course_memberships_capabilities_require_ta to cover the
-- lifecycle axis as well as the role axis.
--
-- 0020 pinned "flags only on a `ta` row". A *dropped* membership still has
-- `role = 'ta'`, so it satisfied that predicate while carrying a live grant
-- -- and listCourseTas filters `dropped_at IS NULL`, so such a row is absent
-- from the only surface that can revoke it. SEC-006 closed that for the one
-- drop path that existed, in application code; this makes it a rule the next
-- drop path cannot forget.
--
-- The normalising UPDATE is prepended to the generated DDL for the same
-- reason 0020's is. Both current drop paths (deactivateByWorkosUserId in
-- repositories/users.ts, and UserIdentityService.reconcileExisting on the
-- way back up) already clear the flags, so no row in a database that has
-- only ever been written by this application can violate the new predicate
-- -- but a long-lived environment that dropped a granted TA through some
-- other means would otherwise have the ADD CONSTRAINT be the statement that
-- blocks a deploy. Normalising first means it cannot be.
UPDATE "course_memberships"
SET "can_view_solutions" = false, "can_view_drafts" = false
WHERE "dropped_at" IS NOT NULL
  AND ("can_view_solutions" = true OR "can_view_drafts" = true);
--> statement-breakpoint
ALTER TABLE "course_memberships" DROP CONSTRAINT "course_memberships_capabilities_require_ta";--> statement-breakpoint
ALTER TABLE "course_memberships" ADD CONSTRAINT "course_memberships_capabilities_require_ta" CHECK (("course_memberships"."role" = 'ta' AND "course_memberships"."dropped_at" IS NULL) OR ("course_memberships"."can_view_solutions" = false AND "course_memberships"."can_view_drafts" = false));--> statement-breakpoint

-- #31 / #98: the columns the instructor-facing config authoring needs.
--
-- `name` is added nullable, backfilled, and only then made NOT NULL.
-- drizzle-kit emitted a bare `ADD COLUMN "name" text NOT NULL`, which is
-- correct against an empty table and fails against any environment that
-- already holds a config row -- Postgres has no value to put there. That is
-- not hypothetical, and it is strictly more certain after #317 than it was
-- when this migration was first written: migration 0029 backfills a default
-- llm_configs row for EVERY organization, and 0035 rewrites it, so a
-- populated llm_configs is now guaranteed on any database that has reached
-- staging's head.
--
-- The backfill uses the model name because it is the only human-meaningful
-- string the row already carries, and a config called "gpt-5.3-codex" is at
-- least true. Instructors rename from the console.
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
--
-- #317 interaction, deliberate: staging's own 0029 UPDATEs the other
-- direction (is_default=true, is_active=false -> is_active=true) so
-- resolveLLMConfig can find a usable row. 0029 runs first and leaves no row
-- for this UPDATE to match; this statement stays as the guard for a row
-- that arrives between the two, and the two are not in conflict -- 0029
-- reactivates, this one demotes only what 0029 could not reach.
UPDATE "llm_configs" SET "is_default" = false WHERE "is_default" AND NOT "is_active";--> statement-breakpoint
ALTER TABLE "llm_configs" ADD CONSTRAINT "llm_configs_active_required_for_default_chk" CHECK (NOT ("llm_configs"."is_default" AND NOT "llm_configs"."is_active"));--> statement-breakpoint
-- #98: a config cannot be its own fallback. New column, so no row can
-- violate it -- stated for symmetry with the constraint above.
ALTER TABLE "llm_configs" ADD CONSTRAINT "llm_configs_fallback_not_self_chk" CHECK ("llm_configs"."fallback_llm_config_id" IS NULL OR "llm_configs"."fallback_llm_config_id" <> "llm_configs"."id");--> statement-breakpoint

-- #75: the grading workflow's columns.
--
-- `max_score` is new, so every existing row has NULL in it -- and
-- grades_score_requires_max_chk rejects a row with a score and no scale.
-- Nothing in the tree writes `grades` today (#14 shipped the table, this
-- issue ships the first writer), so in practice there are no such rows. The
-- normalising UPDATE runs anyway, for the reason the statements above do:
-- the ADD CONSTRAINT must not be the statement that blocks a deploy against
-- an environment that acquired a row by some other means.
--
-- It backfills the SCALE rather than clearing the score. 100 is the
-- conventional denominator and, more to the point, a grade is a record of
-- what a human decided -- guessing at its scale is recoverable and
-- destroying the number is not.
ALTER TABLE "grades" ADD COLUMN "max_score" double precision;--> statement-breakpoint
ALTER TABLE "grades" ADD COLUMN "supersedes_grade_id" uuid;--> statement-breakpoint
UPDATE "grades" SET "max_score" = 100 WHERE "score" IS NOT NULL AND "max_score" IS NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "grades" ADD CONSTRAINT "grades_supersedes_grade_id_grades_id_fk" FOREIGN KEY ("supersedes_grade_id") REFERENCES "public"."grades"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "grades" ADD CONSTRAINT "grades_supersedes_not_self_chk" CHECK ("grades"."supersedes_grade_id" IS NULL OR "grades"."supersedes_grade_id" <> "grades"."id");--> statement-breakpoint
ALTER TABLE "grades" ADD CONSTRAINT "grades_score_requires_max_chk" CHECK (("grades"."score" IS NULL AND "grades"."max_score" IS NULL)
          OR ("grades"."score" IS NOT NULL AND "grades"."max_score" IS NOT NULL AND "grades"."max_score" > 0));
