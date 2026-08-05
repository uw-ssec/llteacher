ALTER TABLE "llm_call_logs" ALTER COLUMN "message_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_span_range_chk" CHECK (("citations"."span_start" IS NULL AND "citations"."span_end" IS NULL)
          OR ("citations"."span_start" >= 0 AND "citations"."span_end" >= 0 AND "citations"."span_start" <= "citations"."span_end"));