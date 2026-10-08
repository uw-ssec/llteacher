DROP INDEX IF EXISTS "organizations_workos_org_uq";--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "workos_organization_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "deployment_singleton" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "courses_org_code_term_uq" ON "courses" USING btree ("organization_id",lower("code"),lower("term"));--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organizations_singleton_uq" ON "organizations" USING btree ("deployment_singleton");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organizations_workos_org_uq" ON "organizations" USING btree ("workos_organization_id") WHERE "organizations"."workos_organization_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_singleton_true" CHECK ("organizations"."deployment_singleton" = true);