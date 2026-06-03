CREATE TYPE "public"."course_role" AS ENUM('instructor', 'ta', 'student', 'observer', 'admin');--> statement-breakpoint
CREATE TYPE "public"."credential_provider" AS ENUM('openai', 'anthropic', 'claude_for_education', 'openrouter', 'local', 'canvas', 'workos');--> statement-breakpoint
CREATE TYPE "public"."lms_provider" AS ENUM('canvas');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "course_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"role" "course_role" NOT NULL,
	"canvas_enrollment_id" text,
	"canvas_role" text,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dropped_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "courses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"canvas_course_id" text,
	"code" text NOT NULL,
	"term" text NOT NULL,
	"title" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lms_integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_id" uuid NOT NULL,
	"provider" "lms_provider" DEFAULT 'canvas' NOT NULL,
	"lti_iss" text NOT NULL,
	"lti_client_id" text NOT NULL,
	"lti_deployment_id" text NOT NULL,
	"api_credential_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lti_launches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lms_integration_id" uuid NOT NULL,
	"user_id" uuid,
	"nonce" text NOT NULL,
	"resource_link_id" text,
	"role_claim" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organization_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" "credential_provider" NOT NULL,
	"label" text NOT NULL,
	"secret_ref" text NOT NULL,
	"rotated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"workos_organization_id" text NOT NULL,
	"canvas_account_id" text,
	"requires_ferpa" boolean DEFAULT true NOT NULL,
	"requires_hipaa" boolean DEFAULT false NOT NULL,
	"data_residency" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workos_user_id" text,
	"email" "bytea" NOT NULL,
	"email_blind_index" "bytea" NOT NULL,
	"netid" "bytea",
	"netid_blind_index" "bytea",
	"display_name" "bytea",
	"is_pending" boolean DEFAULT false NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "course_memberships" ADD CONSTRAINT "course_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "course_memberships" ADD CONSTRAINT "course_memberships_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "courses" ADD CONSTRAINT "courses_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lms_integrations" ADD CONSTRAINT "lms_integrations_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lms_integrations" ADD CONSTRAINT "lms_integrations_api_credential_id_organization_credentials_id_fk" FOREIGN KEY ("api_credential_id") REFERENCES "public"."organization_credentials"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lti_launches" ADD CONSTRAINT "lti_launches_lms_integration_id_lms_integrations_id_fk" FOREIGN KEY ("lms_integration_id") REFERENCES "public"."lms_integrations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lti_launches" ADD CONSTRAINT "lti_launches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "organization_credentials" ADD CONSTRAINT "organization_credentials_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "course_memberships_user_course_uq" ON "course_memberships" USING btree ("user_id","course_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "course_memberships_canvas_enrollment_uq" ON "course_memberships" USING btree ("canvas_enrollment_id") WHERE "course_memberships"."canvas_enrollment_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "course_memberships_course_idx" ON "course_memberships" USING btree ("course_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "courses_org_idx" ON "courses" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "courses_org_canvas_course_uq" ON "courses" USING btree ("organization_id","canvas_course_id") WHERE "courses"."canvas_course_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lms_integrations_course_uq" ON "lms_integrations" USING btree ("course_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lms_integrations_iss_client_deployment_uq" ON "lms_integrations" USING btree ("lti_iss","lti_client_id","lti_deployment_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lti_launches_nonce_uq" ON "lti_launches" USING btree ("nonce");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lti_launches_integration_idx" ON "lti_launches" USING btree ("lms_integration_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lti_launches_user_idx" ON "lti_launches" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "organization_credentials_org_idx" ON "organization_credentials" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organization_credentials_org_provider_label_uq" ON "organization_credentials" USING btree ("organization_id","provider","label");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organizations_slug_uq" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organizations_workos_org_uq" ON "organizations" USING btree ("workos_organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_blind_index_uq" ON "users" USING btree ("email_blind_index");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_workos_user_uq" ON "users" USING btree ("workos_user_id") WHERE "users"."workos_user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_netid_blind_index_uq" ON "users" USING btree ("netid_blind_index") WHERE "users"."netid_blind_index" IS NOT NULL;