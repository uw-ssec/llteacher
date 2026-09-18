CREATE TYPE "public"."knowledge_document_kind" AS ENUM('concept', 'index', 'log');--> statement-breakpoint
CREATE TYPE "public"."knowledge_index_status" AS ENUM('pending', 'indexed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."material_status" AS ENUM('pending', 'processing', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "knowledge_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_id" uuid NOT NULL,
	"path" text NOT NULL,
	"kind" "knowledge_document_kind" DEFAULT 'concept' NOT NULL,
	"type" text,
	"title" text,
	"description" text,
	"tags" jsonb,
	"frontmatter" jsonb,
	"body" text DEFAULT '' NOT NULL,
	"body_original" text,
	"index_status" "knowledge_index_status" DEFAULT 'pending' NOT NULL,
	"source_material_id" uuid,
	"edited_by_id" uuid,
	"edited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_documents_concept_type_chk" CHECK ("knowledge_documents"."kind" <> 'concept' OR "knowledge_documents"."type" IS NOT NULL),
	CONSTRAINT "knowledge_documents_reserved_basename_chk" CHECK (("knowledge_documents"."kind" = 'concept' AND split_part("knowledge_documents"."path", '/', -1) NOT IN ('index', 'log'))
       OR ("knowledge_documents"."kind" = 'index'   AND split_part("knowledge_documents"."path", '/', -1) = 'index')
       OR ("knowledge_documents"."kind" = 'log'     AND "knowledge_documents"."path" = 'log'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_source_material_id_course_materials_id_fk" FOREIGN KEY ("source_material_id") REFERENCES "public"."course_materials"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_edited_by_id_course_memberships_id_fk" FOREIGN KEY ("edited_by_id") REFERENCES "public"."course_memberships"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_documents_course_path_uq" ON "knowledge_documents" USING btree ("course_id","path");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_documents_source_material_idx" ON "knowledge_documents" USING btree ("source_material_id");