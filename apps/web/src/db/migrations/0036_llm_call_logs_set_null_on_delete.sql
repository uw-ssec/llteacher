-- #317 review, #341: llm_call_logs.message_id/.conversation_id were
-- ON DELETE RESTRICT from when this table had no writer. #317 makes
-- chat.ts write one row per turn, so RESTRICT now permanently blocks
-- deleteHomework/updateHomework's section-removal path the moment any
-- section has ever had a single chat turn. Flips both to SET NULL,
-- matching llm_config_id's existing pattern on this same table -- the
-- cost/telemetry row survives the delete, just detached, rather than
-- either blocking the delete or silently losing the accounting.
ALTER TABLE "llm_call_logs" DROP CONSTRAINT "llm_call_logs_message_id_messages_id_fk";
--> statement-breakpoint
ALTER TABLE "llm_call_logs" DROP CONSTRAINT "llm_call_logs_conversation_id_conversations_id_fk";
--> statement-breakpoint
ALTER TABLE "llm_call_logs" ALTER COLUMN "conversation_id" DROP NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "llm_call_logs" ADD CONSTRAINT "llm_call_logs_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "llm_call_logs" ADD CONSTRAINT "llm_call_logs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
