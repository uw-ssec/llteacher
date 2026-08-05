CREATE INDEX IF NOT EXISTS "citations_message_idx" ON "citations" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "citations_grade_idx" ON "citations" USING btree ("grade_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_section_idx" ON "conversations" USING btree ("section_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "grades_grader_membership_idx" ON "grades" USING btree ("grader_membership_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_call_logs_config_idx" ON "llm_call_logs" USING btree ("llm_config_id");