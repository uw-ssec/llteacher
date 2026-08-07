CREATE TABLE IF NOT EXISTS "homework_progress_widgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"homework_id" uuid NOT NULL,
	"pre_prompt" text NOT NULL,
	"post_prompt" text NOT NULL,
	"order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "homework_progress_widgets_order_range_chk" CHECK ("homework_progress_widgets"."order" >= 1 AND "homework_progress_widgets"."order" <= 20)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "homework_progress_widget_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"widget_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"pre_value" integer,
	"pre_submitted_at" timestamp with time zone,
	"post_value" integer,
	"post_submitted_at" timestamp with time zone,
	CONSTRAINT "hpwr_pre_value_range_chk" CHECK ("homework_progress_widget_responses"."pre_value" IS NULL OR ("homework_progress_widget_responses"."pre_value" >= 0 AND "homework_progress_widget_responses"."pre_value" <= 10)),
	CONSTRAINT "hpwr_post_value_range_chk" CHECK ("homework_progress_widget_responses"."post_value" IS NULL OR ("homework_progress_widget_responses"."post_value" >= 0 AND "homework_progress_widget_responses"."post_value" <= 10))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "homework_progress_widgets" ADD CONSTRAINT "homework_progress_widgets_homework_id_homeworks_id_fk" FOREIGN KEY ("homework_id") REFERENCES "public"."homeworks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "homework_progress_widget_responses" ADD CONSTRAINT "homework_progress_widget_responses_widget_id_homework_progress_widgets_id_fk" FOREIGN KEY ("widget_id") REFERENCES "public"."homework_progress_widgets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "homework_progress_widget_responses" ADD CONSTRAINT "homework_progress_widget_responses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "homework_progress_widgets_homework_order_uq" ON "homework_progress_widgets" USING btree ("homework_id","order");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hpwr_widget_user_uq" ON "homework_progress_widget_responses" USING btree ("widget_id","user_id");