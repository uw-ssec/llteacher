-- #167: submissions.source -- 'student' (someone pressed submit) vs 'auto'
-- (the scheduled overdue sweep, server/jobs/autoSubmitOverdue.ts).
--
-- NOT NULL DEFAULT 'student' with no backfill statement, deliberately:
-- every row that exists when this runs predates the sweep, so it can only
-- have come from routes/submissions.ts's submitSectionHandler. The default
-- states that fact for existing rows and for the manual writer, which is
-- left unchanged rather than made to pass 'student' explicitly.
--
-- CREATE TYPE ... AS ENUM in the same transaction as a DEFAULT using one of
-- its values is safe (migration 0041 already does exactly this for
-- hint_action). The SQLSTATE 55P04 hazard scripts/migrate.ts works around
-- is `ALTER TYPE ... ADD VALUE` followed by a use of the NEW value, which
-- this migration does not do -- so no SPLIT_BEFORE_TAG change is needed.
CREATE TYPE "public"."submission_source" AS ENUM('student', 'auto');--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "source" "submission_source" DEFAULT 'student' NOT NULL;
