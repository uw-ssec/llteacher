DROP INDEX IF EXISTS "organizations_workos_org_uq";--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "workos_organization_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "deployment_singleton" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "organizations" SET "deployment_singleton" = true WHERE "id" = (SELECT "id" FROM "organizations" ORDER BY "created_at", "id" LIMIT 1);--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "courses"
    GROUP BY "organization_id", lower("code"), lower("term")
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'Cannot normalize course identity: duplicate organization/code/term rows differ only by case',
      HINT = 'Rename or consolidate the duplicate course shells, then rerun the migration.';
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "courses_org_code_term_uq" ON "courses" USING btree ("organization_id",lower("code"),lower("term"));--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organizations_singleton_uq" ON "organizations" USING btree ("deployment_singleton") WHERE "organizations"."deployment_singleton" = true;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organizations_workos_org_uq" ON "organizations" USING btree ("workos_organization_id") WHERE "organizations"."workos_organization_id" IS NOT NULL;--> statement-breakpoint
