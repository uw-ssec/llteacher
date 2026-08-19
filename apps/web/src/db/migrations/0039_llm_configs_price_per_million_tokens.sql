ALTER TABLE "llm_configs" ADD COLUMN "price_per_million_input_tokens" double precision;--> statement-breakpoint
ALTER TABLE "llm_configs" ADD COLUMN "price_per_million_output_tokens" double precision;