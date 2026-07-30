CREATE TYPE "public"."llm_provider" AS ENUM('openai', 'anthropic', 'claude_for_education', 'openrouter', 'local');--> statement-breakpoint
CREATE TYPE "public"."material_source_type" AS ENUM('pdf', 'slides', 'transcript', 'syllabus', 'other');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"role_description" text NOT NULL,
	"default_prompt_template_id" uuid,
	"default_llm_config_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "course_materials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_id" uuid NOT NULL,
	"uploaded_by_id" uuid NOT NULL,
	"source_type" "material_source_type" NOT NULL,
	"title" text NOT NULL,
	"original_filename" text,
	"upload_metadata" jsonb,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "homeworks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_id" uuid NOT NULL,
	"created_by_id" uuid NOT NULL,
	"prompt_template_id" uuid,
	"llm_config_id" uuid,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"due_date" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "llm_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" "llm_provider" NOT NULL,
	"model_name" text NOT NULL,
	"temperature" double precision DEFAULT 0.7 NOT NULL,
	"max_completion_tokens" integer DEFAULT 1000 NOT NULL,
	"credential_id" uuid,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_configs_temperature_range_chk" CHECK ("llm_configs"."temperature" >= 0 AND "llm_configs"."temperature" <= 2)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "material_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"material_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"text" text NOT NULL,
	"embedding" vector(1536),
	"token_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "prompt_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_organization_id" uuid,
	"scope_course_id" uuid,
	"scope_homework_id" uuid,
	"scope_section_id" uuid,
	"previous_version_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"content" text NOT NULL,
	"compose_with_parent" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prompt_templates_exactly_one_scope_chk" CHECK (num_nonnulls("prompt_templates"."scope_organization_id", "prompt_templates"."scope_course_id", "prompt_templates"."scope_homework_id", "prompt_templates"."scope_section_id") = 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "section_solutions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"section_id" uuid NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"homework_id" uuid NOT NULL,
	"prompt_template_id" uuid,
	"order" integer NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sections_order_range_chk" CHECK ("sections"."order" >= 1 AND "sections"."order" <= 20)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_definitions" ADD CONSTRAINT "agent_definitions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_definitions" ADD CONSTRAINT "agent_definitions_default_prompt_template_id_prompt_templates_id_fk" FOREIGN KEY ("default_prompt_template_id") REFERENCES "public"."prompt_templates"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_definitions" ADD CONSTRAINT "agent_definitions_default_llm_config_id_llm_configs_id_fk" FOREIGN KEY ("default_llm_config_id") REFERENCES "public"."llm_configs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "course_materials" ADD CONSTRAINT "course_materials_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "course_materials" ADD CONSTRAINT "course_materials_uploaded_by_id_course_memberships_id_fk" FOREIGN KEY ("uploaded_by_id") REFERENCES "public"."course_memberships"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "homeworks" ADD CONSTRAINT "homeworks_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "homeworks" ADD CONSTRAINT "homeworks_created_by_id_course_memberships_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."course_memberships"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "homeworks" ADD CONSTRAINT "homeworks_prompt_template_id_prompt_templates_id_fk" FOREIGN KEY ("prompt_template_id") REFERENCES "public"."prompt_templates"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "homeworks" ADD CONSTRAINT "homeworks_llm_config_id_llm_configs_id_fk" FOREIGN KEY ("llm_config_id") REFERENCES "public"."llm_configs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "llm_configs" ADD CONSTRAINT "llm_configs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "llm_configs" ADD CONSTRAINT "llm_configs_credential_id_organization_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."organization_credentials"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "material_chunks" ADD CONSTRAINT "material_chunks_material_id_course_materials_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."course_materials"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "prompt_templates" ADD CONSTRAINT "prompt_templates_scope_organization_id_organizations_id_fk" FOREIGN KEY ("scope_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "prompt_templates" ADD CONSTRAINT "prompt_templates_scope_course_id_courses_id_fk" FOREIGN KEY ("scope_course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "prompt_templates" ADD CONSTRAINT "prompt_templates_scope_homework_id_homeworks_id_fk" FOREIGN KEY ("scope_homework_id") REFERENCES "public"."homeworks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "prompt_templates" ADD CONSTRAINT "prompt_templates_scope_section_id_sections_id_fk" FOREIGN KEY ("scope_section_id") REFERENCES "public"."sections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "prompt_templates" ADD CONSTRAINT "prompt_templates_previous_version_id_prompt_templates_id_fk" FOREIGN KEY ("previous_version_id") REFERENCES "public"."prompt_templates"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "section_solutions" ADD CONSTRAINT "section_solutions_section_id_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."sections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sections" ADD CONSTRAINT "sections_homework_id_homeworks_id_fk" FOREIGN KEY ("homework_id") REFERENCES "public"."homeworks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sections" ADD CONSTRAINT "sections_prompt_template_id_prompt_templates_id_fk" FOREIGN KEY ("prompt_template_id") REFERENCES "public"."prompt_templates"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_definitions_org_name_uq" ON "agent_definitions" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "course_materials_course_idx" ON "course_materials" USING btree ("course_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "homeworks_course_idx" ON "homeworks" USING btree ("course_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "homeworks_created_by_idx" ON "homeworks" USING btree ("created_by_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_configs_org_idx" ON "llm_configs" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "llm_configs_org_default_uq" ON "llm_configs" USING btree ("organization_id") WHERE "llm_configs"."is_default" = true;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "material_chunks_material_ordinal_uq" ON "material_chunks" USING btree ("material_id","ordinal");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "material_chunks_material_idx" ON "material_chunks" USING btree ("material_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prompt_templates_scope_org_idx" ON "prompt_templates" USING btree ("scope_organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prompt_templates_scope_course_idx" ON "prompt_templates" USING btree ("scope_course_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prompt_templates_scope_homework_idx" ON "prompt_templates" USING btree ("scope_homework_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prompt_templates_scope_section_idx" ON "prompt_templates" USING btree ("scope_section_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "section_solutions_section_uq" ON "section_solutions" USING btree ("section_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sections_homework_order_uq" ON "sections" USING btree ("homework_id","order");