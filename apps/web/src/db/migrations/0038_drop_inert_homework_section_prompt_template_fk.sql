-- PR #317 review, non-blocking #347 (requirement 2).
--
-- homeworks.prompt_template_id / sections.prompt_template_id were never
-- read or written by anything: resolvePromptTemplate (lib/prompts.ts)
-- resolves by prompt_templates.scope_*_id alone, and no route or form ever
-- set either column. Left in place, they read as a working per-homework/
-- per-section override -- exactly the pattern courses.llm_config_id and
-- homeworks.llm_config_id actually implement for LLM config resolution --
-- which is precisely the trap #347 found. Dropped rather than documented
-- as unused: a schema column claiming to be a real override is a stronger,
-- more persistent false signal than a comment, and nothing anywhere
-- depended on either column's presence.
ALTER TABLE "homeworks" DROP CONSTRAINT "homeworks_prompt_template_id_prompt_templates_id_fk";
--> statement-breakpoint
ALTER TABLE "sections" DROP CONSTRAINT "sections_prompt_template_id_prompt_templates_id_fk";
--> statement-breakpoint
ALTER TABLE "homeworks" DROP COLUMN IF EXISTS "prompt_template_id";--> statement-breakpoint
ALTER TABLE "sections" DROP COLUMN IF EXISTS "prompt_template_id";