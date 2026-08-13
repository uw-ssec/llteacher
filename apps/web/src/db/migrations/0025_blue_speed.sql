ALTER TABLE "conversations" DROP CONSTRAINT "conversations_kind_section_chk";--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_kind_section_chk" CHECK (("conversations"."kind" <> 'tutor' OR "conversations"."section_id" IS NULL)
          AND ("conversations"."kind" <> 'section' OR "conversations"."section_id" IS NOT NULL));