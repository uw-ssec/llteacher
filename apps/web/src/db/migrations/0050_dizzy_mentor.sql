CREATE TABLE IF NOT EXISTS "knowledge_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_document_id" uuid NOT NULL,
	"raw_href" text NOT NULL,
	"target_path" text NOT NULL,
	"resolved_document_id" uuid,
	"is_broken" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "material_chunks" DROP CONSTRAINT "material_chunks_material_id_course_materials_id_fk";
--> statement-breakpoint
DROP INDEX IF EXISTS "material_chunks_material_ordinal_uq";--> statement-breakpoint
DROP INDEX IF EXISTS "material_chunks_material_idx";--> statement-breakpoint
ALTER TABLE "course_materials" ADD COLUMN "storage_key" text;--> statement-breakpoint
ALTER TABLE "course_materials" ADD COLUMN "byte_size" integer;--> statement-breakpoint
ALTER TABLE "course_materials" ADD COLUMN "content_type" text;--> statement-breakpoint
ALTER TABLE "course_materials" ADD COLUMN "checksum" text;--> statement-breakpoint
ALTER TABLE "course_materials" ADD COLUMN "status" "material_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "course_materials" ADD COLUMN "error_detail" text;--> statement-breakpoint
ALTER TABLE "material_chunks" ADD COLUMN "document_id" uuid NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "knowledge_links" ADD CONSTRAINT "knowledge_links_source_document_id_knowledge_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."knowledge_documents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "knowledge_links" ADD CONSTRAINT "knowledge_links_resolved_document_id_knowledge_documents_id_fk" FOREIGN KEY ("resolved_document_id") REFERENCES "public"."knowledge_documents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_links_source_idx" ON "knowledge_links" USING btree ("source_document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_links_resolved_idx" ON "knowledge_links" USING btree ("resolved_document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_links_target_path_idx" ON "knowledge_links" USING btree ("target_path");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "material_chunks" ADD CONSTRAINT "material_chunks_document_id_knowledge_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."knowledge_documents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "material_chunks_document_ordinal_uq" ON "material_chunks" USING btree ("document_id","ordinal");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "material_chunks_document_idx" ON "material_chunks" USING btree ("document_id");--> statement-breakpoint
ALTER TABLE "material_chunks" DROP COLUMN IF EXISTS "material_id";