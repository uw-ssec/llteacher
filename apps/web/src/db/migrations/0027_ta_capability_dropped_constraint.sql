-- #207: widen course_memberships_capabilities_require_ta to cover the
-- lifecycle axis as well as the role axis.
--
-- 0020 pinned "flags only on a `ta` row". A *dropped* membership still has
-- `role = 'ta'`, so it satisfied that predicate while carrying a live grant
-- -- and listCourseTas filters `dropped_at IS NULL`, so such a row is absent
-- from the only surface that can revoke it. SEC-006 closed that for the one
-- drop path that existed, in application code; this makes it a rule the next
-- drop path cannot forget.
--
-- The normalising UPDATE is prepended to the generated DDL for the same
-- reason 0020's is. Both current drop paths (deactivateByWorkosUserId in
-- repositories/users.ts, and UserIdentityService.reconcileExisting on the
-- way back up) already clear the flags, so no row in a database that has
-- only ever been written by this application can violate the new predicate
-- -- but a long-lived environment that dropped a granted TA through some
-- other means would otherwise have the ADD CONSTRAINT be the statement that
-- blocks a deploy. Normalising first means it cannot be.
--
-- Not idempotent, and does not need to be: drizzle's journal applies each
-- migration exactly once. The UPDATE is; the ADD CONSTRAINT is not.
UPDATE "course_memberships"
SET "can_view_solutions" = false, "can_view_drafts" = false
WHERE "dropped_at" IS NOT NULL
  AND ("can_view_solutions" = true OR "can_view_drafts" = true);
--> statement-breakpoint
ALTER TABLE "course_memberships" DROP CONSTRAINT "course_memberships_capabilities_require_ta";--> statement-breakpoint
ALTER TABLE "course_memberships" ADD CONSTRAINT "course_memberships_capabilities_require_ta" CHECK (("course_memberships"."role" = 'ta' AND "course_memberships"."dropped_at" IS NULL) OR ("course_memberships"."can_view_solutions" = false AND "course_memberships"."can_view_drafts" = false));
