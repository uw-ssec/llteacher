-- Added nullable, backfilled, then locked NOT NULL -- rather than a
-- straight "ADD COLUMN ... NOT NULL" -- so this migration applies cleanly
-- even against an environment where response_feedback already has rows
-- (e.g. a local dev DB exercised before this migration landed), not only a
-- fresh/empty table. courseId is copied from each row's own conversation,
-- the exact value flagResponse (repositories/responseFeedback.ts) now also
-- writes on every new insert going forward.
ALTER TABLE "response_feedback" ADD COLUMN "course_id" uuid;--> statement-breakpoint
UPDATE "response_feedback" rf SET "course_id" = c.course_id FROM "conversations" c WHERE c.id = rf.conversation_id AND rf.course_id IS NULL;--> statement-breakpoint
ALTER TABLE "response_feedback" ALTER COLUMN "course_id" SET NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "response_feedback" ADD CONSTRAINT "response_feedback_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "response_feedback_course_flagged_idx" ON "response_feedback" USING btree ("course_id","flagged_at");