ALTER TABLE "homework_progress_widget_responses" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
UPDATE "homework_progress_widget_responses" AS r
SET "organization_id" = c."organization_id"
FROM "homework_progress_widgets" AS w
JOIN "homeworks" AS h ON h."id" = w."homework_id"
JOIN "courses" AS c ON c."id" = h."course_id"
WHERE w."id" = r."widget_id";--> statement-breakpoint
ALTER TABLE "homework_progress_widget_responses" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "homework_progress_widget_responses" ADD CONSTRAINT "homework_progress_widget_responses_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hpwr_org_idx" ON "homework_progress_widget_responses" USING btree ("organization_id");
