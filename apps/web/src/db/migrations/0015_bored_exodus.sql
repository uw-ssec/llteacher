ALTER TABLE "homeworks" ADD COLUMN "is_hidden" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "homeworks" ADD COLUMN "expires_at" timestamp with time zone;