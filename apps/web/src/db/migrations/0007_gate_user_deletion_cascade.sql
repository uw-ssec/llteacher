ALTER TABLE "grades" DROP CONSTRAINT "grades_submission_id_submissions_id_fk";
--> statement-breakpoint
ALTER TABLE "llm_call_logs" DROP CONSTRAINT "llm_call_logs_message_id_messages_id_fk";
--> statement-breakpoint
ALTER TABLE "llm_call_logs" DROP CONSTRAINT "llm_call_logs_conversation_id_conversations_id_fk";
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "grades" ADD CONSTRAINT "grades_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "llm_call_logs" ADD CONSTRAINT "llm_call_logs_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "llm_call_logs" ADD CONSTRAINT "llm_call_logs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
