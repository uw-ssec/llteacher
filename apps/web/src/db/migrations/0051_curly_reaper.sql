CREATE TABLE IF NOT EXISTS "collection_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collection_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"scope_course_id" uuid,
	"scope_homework_id" uuid,
	"scope_section_id" uuid,
	"scope_llm_config_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_attachments_exactly_one_scope_chk" CHECK (num_nonnulls("collection_attachments"."scope_course_id", "collection_attachments"."scope_homework_id", "collection_attachments"."scope_section_id", "collection_attachments"."scope_llm_config_id") = 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "collection_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collection_id" uuid NOT NULL,
	"document_id" uuid,
	"directory_path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_items_exactly_one_target_chk" CHECK (num_nonnulls("collection_items"."document_id", "collection_items"."directory_path") = 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "material_collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "collection_attachments" ADD CONSTRAINT "collection_attachments_collection_id_material_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."material_collections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "collection_attachments" ADD CONSTRAINT "collection_attachments_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "collection_attachments" ADD CONSTRAINT "collection_attachments_scope_course_id_courses_id_fk" FOREIGN KEY ("scope_course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "collection_attachments" ADD CONSTRAINT "collection_attachments_scope_homework_id_homeworks_id_fk" FOREIGN KEY ("scope_homework_id") REFERENCES "public"."homeworks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "collection_attachments" ADD CONSTRAINT "collection_attachments_scope_section_id_sections_id_fk" FOREIGN KEY ("scope_section_id") REFERENCES "public"."sections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "collection_attachments" ADD CONSTRAINT "collection_attachments_scope_llm_config_id_llm_configs_id_fk" FOREIGN KEY ("scope_llm_config_id") REFERENCES "public"."llm_configs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_collection_id_material_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."material_collections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_document_id_knowledge_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."knowledge_documents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "material_collections" ADD CONSTRAINT "material_collections_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "material_collections" ADD CONSTRAINT "material_collections_created_by_id_course_memberships_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."course_memberships"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collection_attachments_course_idx" ON "collection_attachments" USING btree ("course_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collection_attachments_scope_course_idx" ON "collection_attachments" USING btree ("scope_course_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collection_attachments_scope_homework_idx" ON "collection_attachments" USING btree ("scope_homework_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collection_attachments_scope_section_idx" ON "collection_attachments" USING btree ("scope_section_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collection_attachments_scope_llm_config_idx" ON "collection_attachments" USING btree ("scope_llm_config_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "collection_attachments_course_uq" ON "collection_attachments" USING btree ("collection_id","scope_course_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "collection_attachments_homework_uq" ON "collection_attachments" USING btree ("collection_id","scope_homework_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "collection_attachments_section_uq" ON "collection_attachments" USING btree ("collection_id","scope_section_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "collection_attachments_llm_config_uq" ON "collection_attachments" USING btree ("collection_id","scope_llm_config_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "collection_items_collection_document_uq" ON "collection_items" USING btree ("collection_id","document_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "collection_items_collection_directory_uq" ON "collection_items" USING btree ("collection_id","directory_path");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collection_items_collection_idx" ON "collection_items" USING btree ("collection_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "material_collections_course_name_uq" ON "material_collections" USING btree ("course_id","name");