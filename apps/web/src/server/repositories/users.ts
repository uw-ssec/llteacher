import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { courseMemberships } from "../../db/schema";

/** Intentionally takes no OrgScope/CourseScope. This query is how
 *  rolesMiddleware discovers which orgs/courses a user belongs to in the
 *  first place -- it can't be scoped to a tenant it hasn't resolved yet.
 *  Still routed through the repository layer so no route/middleware
 *  imports Drizzle directly, per the convention in apps/web/ARCHITECTURE.md.
 *
 *  Caveat: does not filter on `droppedAt` -- a dropped membership (roster
 *  removal via Canvas sync) is still returned and counts as active for
 *  every AuthContext predicate (`isMemberOf`, `isInstructorOf`, `hasRole`)
 *  derived from it. Pre-existing M1 behavior, not something this function
 *  introduced; flagged here so a future consumer doesn't inherit it
 *  silently. */
export async function listMembershipsForUser(db: Db, userId: string) {
  return db.query.courseMemberships.findMany({
    where: eq(courseMemberships.userId, userId),
  });
}
