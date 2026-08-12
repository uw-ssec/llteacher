ALTER TABLE "messages" ADD COLUMN "client_message_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "seq" bigserial NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_conversation_seq_idx" ON "messages" USING btree ("conversation_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "messages_conversation_client_message_id_idx" ON "messages" USING btree ("conversation_id","client_message_id");