-- #172 audit (SEC-004): capability flags are only meaningful on a `ta`
-- membership. Reads already ignore them on any other role, but nothing
-- cleared them when a role changed, so a ta -> student -> ta transition on
-- the same row would silently revive a previously granted capability.
--
-- The backfill is deliberate, not decorative. `drizzle-kit generate` emits
-- only the ADD CONSTRAINT, which is correct here (0019 defaults both columns
-- to false and ships in the same PR, so no row can violate it today) but
-- would fail against any environment that picked up a violating row before
-- this migration ran -- e.g. a long-lived staging database where 0019 landed
-- ahead of 0020. Normalising first means the ADD CONSTRAINT cannot be the
-- statement that blocks a deploy.
--
-- To be precise about what that does and does not buy: the UPDATE is
-- idempotent, the ADD CONSTRAINT is not (a second run raises "constraint
-- already exists" -- there is no IF NOT EXISTS form for ADD CONSTRAINT in
-- the Postgres versions we target). An earlier version of this comment
-- called the migration "idempotent and replayable"; it is neither, and it
-- does not need to be, since drizzle's journal applies each migration
-- exactly once.
UPDATE "course_memberships"
SET "can_view_solutions" = false, "can_view_drafts" = false
WHERE "role" <> 'ta'
  AND ("can_view_solutions" = true OR "can_view_drafts" = true);
--> statement-breakpoint
ALTER TABLE "course_memberships" ADD CONSTRAINT "course_memberships_capabilities_require_ta" CHECK ("course_memberships"."role" = 'ta' OR ("course_memberships"."can_view_solutions" = false AND "course_memberships"."can_view_drafts" = false));
