ALTER TABLE "grades" ADD COLUMN "max_score" double precision;--> statement-breakpoint
ALTER TABLE "grades" ADD COLUMN "supersedes_grade_id" uuid;--> statement-breakpoint
-- #75: the grading workflow's columns.
--
-- `max_score` is new, so every existing row has NULL in it -- and
-- grades_score_requires_max_chk rejects a row with a score and no scale.
-- Nothing in the tree writes `grades` today (#14 shipped the table, this
-- issue ships the first writer), so in practice there are no such rows. The
-- normalising UPDATE runs anyway, for the reason 0020, 0027 and 0028's do:
-- the ADD CONSTRAINT must not be the statement that blocks a deploy against
-- an environment that acquired a row by some other means.
--
-- It backfills the SCALE rather than clearing the score. 100 is the
-- conventional denominator and, more to the point, a grade is a record of
-- what a human decided -- guessing at its scale is recoverable and
-- destroying the number is not.
UPDATE "grades" SET "max_score" = 100 WHERE "score" IS NOT NULL AND "max_score" IS NULL;
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "grades" ADD CONSTRAINT "grades_supersedes_grade_id_grades_id_fk" FOREIGN KEY ("supersedes_grade_id") REFERENCES "public"."grades"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "grades" ADD CONSTRAINT "grades_supersedes_not_self_chk" CHECK ("grades"."supersedes_grade_id" IS NULL OR "grades"."supersedes_grade_id" <> "grades"."id");--> statement-breakpoint
ALTER TABLE "grades" ADD CONSTRAINT "grades_score_requires_max_chk" CHECK (("grades"."score" IS NULL AND "grades"."max_score" IS NULL)
          OR ("grades"."score" IS NOT NULL AND "grades"."max_score" IS NOT NULL AND "grades"."max_score" > 0));