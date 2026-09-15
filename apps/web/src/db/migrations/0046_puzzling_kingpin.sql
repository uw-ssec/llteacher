CREATE TYPE "public"."lms_sync_status" AS ENUM('idle', 'syncing', 'success', 'error');--> statement-breakpoint
DROP INDEX IF EXISTS "lms_integrations_iss_client_deployment_uq";--> statement-breakpoint
ALTER TABLE "lms_integrations" ALTER COLUMN "lti_iss" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "lms_integrations" ALTER COLUMN "lti_client_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "lms_integrations" ALTER COLUMN "lti_deployment_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_credentials" ALTER COLUMN "secret_ref" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "lms_integrations" ADD COLUMN "last_sync_status" "lms_sync_status" DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE "lms_integrations" ADD COLUMN "last_sync_counts" jsonb;--> statement-breakpoint
ALTER TABLE "lms_integrations" ADD COLUMN "last_sync_error_message" text;--> statement-breakpoint
ALTER TABLE "organization_credentials" ADD COLUMN "encrypted_secret" "bytea";--> statement-breakpoint
ALTER TABLE "organization_credentials" ADD COLUMN "canvas_base_url" text;--> statement-breakpoint
ALTER TABLE "organization_credentials" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lms_integrations_iss_client_deployment_uq" ON "lms_integrations" USING btree ("lti_iss","lti_client_id","lti_deployment_id") WHERE "lms_integrations"."lti_iss" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_credentials" ADD CONSTRAINT "organization_credentials_exactly_one_secret_shape_chk" CHECK (("organization_credentials"."secret_ref" IS NOT NULL) <> ("organization_credentials"."encrypted_secret" IS NOT NULL));