CREATE TYPE "public"."hint_action" AS ENUM('request_hint');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hint_budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"section_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"max_hints" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hint_budgets_section_id_unique" UNIQUE("section_id"),
	CONSTRAINT "hint_budgets_max_hints_chk" CHECK ("hint_budgets"."max_hints" IS NULL OR "hint_budgets"."max_hints" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hint_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"action" "hint_action" DEFAULT 'request_hint' NOT NULL,
	"is_limit_reached" boolean DEFAULT false NOT NULL,
	"prompt_template_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "hint_budgets" ADD CONSTRAINT "hint_budgets_section_id_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."sections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "hint_budgets" ADD CONSTRAINT "hint_budgets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "hint_events" ADD CONSTRAINT "hint_events_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "hint_events" ADD CONSTRAINT "hint_events_section_id_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."sections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "hint_events" ADD CONSTRAINT "hint_events_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "hint_events" ADD CONSTRAINT "hint_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "hint_events" ADD CONSTRAINT "hint_events_prompt_template_id_prompt_templates_id_fk" FOREIGN KEY ("prompt_template_id") REFERENCES "public"."prompt_templates"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hint_budgets_org_idx" ON "hint_budgets" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hint_events_section_student_idx" ON "hint_events" USING btree ("section_id","student_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hint_events_conversation_student_created_idx" ON "hint_events" USING btree ("conversation_id","student_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hint_events_org_idx" ON "hint_events" USING btree ("organization_id");