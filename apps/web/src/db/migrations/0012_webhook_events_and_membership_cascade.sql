CREATE TYPE "public"."membership_drop_reason" AS ENUM('roster_removal', 'user_deprovisioned');--> statement-breakpoint
CREATE TYPE "public"."webhook_event_status" AS ENUM('processed', 'skipped', 'failed');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workos_webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "webhook_event_status" NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "course_memberships" ADD COLUMN "dropped_reason" "membership_drop_reason";--> statement-breakpoint
ALTER TABLE "course_memberships" ADD CONSTRAINT "course_memberships_dropped_reason_requires_dropped_at" CHECK ("course_memberships"."dropped_reason" IS NULL OR "course_memberships"."dropped_at" IS NOT NULL);