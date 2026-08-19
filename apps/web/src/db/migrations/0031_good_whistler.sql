-- PR #317 review, non-blocking #348 (requirement 1): prompt_templates has
-- carried version/previous_version_id with is_active defaulting to true
-- since 0001, and repositories/promptTemplates.ts's own doc comment records
-- that this table was administered by hand-written SQL per environment
-- before this PR's first real writer -- so "multiple active rows at one
-- scope" is a state 30 migrations have permitted, not a hypothetical.
-- Reproduced: two active rows sharing a scope column make the unique index
-- creation below fail with "could not create unique index ... Key is
-- duplicated", rolling back this whole migration transaction. Fails closed
-- (db:migrate exits non-zero, `&&` aborts the deploy), which is why this
-- was non-blocking -- but CI never exercises a POPULATED database (a fresh
-- Postgres is migrated, then seeded), so nothing catches this before a real
-- deploy against a real, previously-hand-administered database.
--
-- Normalizes ahead of each index: for every group of active rows sharing a
-- scope column, keeps only the highest-version row active and deactivates
-- the rest. `id DESC` is a deterministic tiebreak for the (hopefully
-- unreached) case of two rows sharing both a scope and a version -- Postgres
-- window functions need a fully deterministic ORDER BY to make "keep
-- exactly one" well-defined at all.
UPDATE "prompt_templates"
SET "is_active" = false
WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id", ROW_NUMBER() OVER (PARTITION BY "scope_organization_id" ORDER BY "version" DESC, "id" DESC) AS rn
    FROM "prompt_templates"
    WHERE "scope_organization_id" IS NOT NULL AND "is_active" = true
  ) ranked
  WHERE rn > 1
);--> statement-breakpoint
UPDATE "prompt_templates"
SET "is_active" = false
WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id", ROW_NUMBER() OVER (PARTITION BY "scope_course_id" ORDER BY "version" DESC, "id" DESC) AS rn
    FROM "prompt_templates"
    WHERE "scope_course_id" IS NOT NULL AND "is_active" = true
  ) ranked
  WHERE rn > 1
);--> statement-breakpoint
UPDATE "prompt_templates"
SET "is_active" = false
WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id", ROW_NUMBER() OVER (PARTITION BY "scope_homework_id" ORDER BY "version" DESC, "id" DESC) AS rn
    FROM "prompt_templates"
    WHERE "scope_homework_id" IS NOT NULL AND "is_active" = true
  ) ranked
  WHERE rn > 1
);--> statement-breakpoint
UPDATE "prompt_templates"
SET "is_active" = false
WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id", ROW_NUMBER() OVER (PARTITION BY "scope_section_id" ORDER BY "version" DESC, "id" DESC) AS rn
    FROM "prompt_templates"
    WHERE "scope_section_id" IS NOT NULL AND "is_active" = true
  ) ranked
  WHERE rn > 1
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "prompt_templates_scope_org_active_uq" ON "prompt_templates" USING btree ("scope_organization_id") WHERE "prompt_templates"."is_active" = true;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "prompt_templates_scope_course_active_uq" ON "prompt_templates" USING btree ("scope_course_id") WHERE "prompt_templates"."is_active" = true;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "prompt_templates_scope_homework_active_uq" ON "prompt_templates" USING btree ("scope_homework_id") WHERE "prompt_templates"."is_active" = true;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "prompt_templates_scope_section_active_uq" ON "prompt_templates" USING btree ("scope_section_id") WHERE "prompt_templates"."is_active" = true;