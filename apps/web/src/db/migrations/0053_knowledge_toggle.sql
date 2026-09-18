ALTER TABLE "courses" ADD COLUMN "knowledge_instruction" text;--> statement-breakpoint
ALTER TABLE "llm_configs" ADD COLUMN "knowledge_enabled" boolean DEFAULT true NOT NULL;