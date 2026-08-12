ALTER TABLE "messages" ADD COLUMN "client_message_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "seq" bigint;--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "messages_seq_seq" OWNED BY "messages"."seq";--> statement-breakpoint
UPDATE "messages" AS m
SET "seq" = ordered.rn
FROM (
	SELECT "id", row_number() OVER (ORDER BY "created_at", "id") AS rn
	FROM "messages"
) AS ordered
WHERE ordered."id" = m."id";--> statement-breakpoint
SELECT setval('"messages_seq_seq"', COALESCE((SELECT max("seq") FROM "messages"), 0) + 1, false);--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "seq" SET DEFAULT nextval('"messages_seq_seq"');--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "seq" SET NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_conversation_seq_idx" ON "messages" USING btree ("conversation_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "messages_conversation_client_message_id_idx" ON "messages" USING btree ("conversation_id","client_message_id");