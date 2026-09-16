ALTER TABLE "citations" ALTER COLUMN "material_chunk_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "course_materials" ADD COLUMN "relative_path" text;--> statement-breakpoint
ALTER TABLE "course_materials" ADD COLUMN "document_path" text;--> statement-breakpoint
ALTER TABLE "citations" ADD COLUMN "concept_path" text;--> statement-breakpoint
ALTER TABLE "citations" ADD COLUMN "concept_title" text;--> statement-breakpoint
ALTER TABLE "citations" ADD COLUMN "course_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "citations" ADD CONSTRAINT "citations_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "citations_course_idx" ON "citations" USING btree ("course_id");--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_single_target_chk" CHECK (num_nonnulls("citations"."material_chunk_id", "citations"."concept_path") = 1);