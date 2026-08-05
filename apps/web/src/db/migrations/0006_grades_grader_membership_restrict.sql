ALTER TABLE "grades" DROP CONSTRAINT "grades_grader_membership_id_course_memberships_id_fk";
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "grades" ADD CONSTRAINT "grades_grader_membership_id_course_memberships_id_fk" FOREIGN KEY ("grader_membership_id") REFERENCES "public"."course_memberships"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
