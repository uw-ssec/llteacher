CREATE TYPE "public"."feedback_reason" AS ENUM('incorrect', 'gave_away_answer', 'confusing', 'other');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "response_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"message_id" uuid,
	"student_id" uuid NOT NULL,
	"reason" "feedback_reason" NOT NULL,
	"comment" text,
	"response_snapshot" jsonb NOT NULL,
	"flagged_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "response_feedback" ADD CONSTRAINT "response_feedback_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "response_feedback" ADD CONSTRAINT "response_feedback_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "response_feedback" ADD CONSTRAINT "response_feedback_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "response_feedback_conversation_idx" ON "response_feedback" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "response_feedback_student_idx" ON "response_feedback" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "response_feedback_message_idx" ON "response_feedback" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "response_feedback_message_student_uq" ON "response_feedback" USING btree ("message_id","student_id");