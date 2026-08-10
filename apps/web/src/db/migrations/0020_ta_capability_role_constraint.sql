-- #172 audit (SEC-004): capability flags are only meaningful on a `ta`
-- membership. Reads already ignore them on any other role, but nothing
-- cleared them when a role changed, so a ta -> student -> ta transition on
-- the same row would silently revive a previously granted capability.
--
-- The backfill is deliberate, not decorative. `drizzle-kit generate` emits
-- only the ADD CONSTRAINT, which is correct here (0019 defaults both columns
-- to false and ships in the same PR, so no row can violate it today) but is
-- not safe to replay against an environment where the table picked up rows
-- with flags set on a non-ta role first -- there the bare ADD CONSTRAINT
-- fails and blocks the deploy. Normalising first makes this migration
-- idempotent and replayable.
UPDATE "course_memberships"
SET "can_view_solutions" = false, "can_view_drafts" = false
WHERE "role" <> 'ta'
  AND ("can_view_solutions" = true OR "can_view_drafts" = true);
--> statement-breakpoint
ALTER TABLE "course_memberships" ADD CONSTRAINT "course_memberships_capabilities_require_ta" CHECK ("course_memberships"."role" = 'ta' OR ("course_memberships"."can_view_solutions" = false AND "course_memberships"."can_view_drafts" = false));
