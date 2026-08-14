CREATE TABLE IF NOT EXISTS "chat_rate_limit_windows" (
	"user_id" uuid NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chat_rate_limit_windows" ADD CONSTRAINT "chat_rate_limit_windows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_rate_limit_windows_user_window_idx" ON "chat_rate_limit_windows" USING btree ("user_id","window_start");