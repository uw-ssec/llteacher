CREATE TYPE "public"."section_type" AS ENUM('conversation', 'non_interactive');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "section_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"section_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"content" text NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sections" ADD COLUMN "type" "section_type" DEFAULT 'conversation' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "section_answers" ADD CONSTRAINT "section_answers_section_id_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."sections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "section_answers" ADD CONSTRAINT "section_answers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "section_answers" ADD CONSTRAINT "section_answers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "section_answers_user_section_uq" ON "section_answers" USING btree ("user_id","section_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "section_answers_org_idx" ON "section_answers" USING btree ("organization_id");