import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../../db/client";
import { courseMemberships } from "../../db/schema";

/** Intentionally takes no OrgScope/CourseScope. This query is how
 *  rolesMiddleware discovers which orgs/courses a user belongs to in the
 *  first place -- it can't be scoped to a tenant it hasn't resolved yet.
 *  Still routed through the repository layer so no route/middleware
 *  imports Drizzle directly, per the convention in apps/web/ARCHITECTURE.md.
 *
 *  Enforced: filters `droppedAt IS NULL`. This is the sole feed into every
 *  AuthContext predicate (`isMemberOf`, `isInstructorOf`, `hasRole`) and,
 *  via `courseScopeFromAuthContext`, every scope-guarded repository call --
 *  a dropped membership (roster removal, e.g. from a future Canvas sync)
 *  must not still count as active access. No `includeDropped` escape hatch
 *  yet since nothing needs one; add it if/when an instructor roster view
 *  needs to see dropped rows too. */
export async function listMembershipsForUser(db: Db, userId: string) {
  return db.query.courseMemberships.findMany({
    where: and(eq(courseMemberships.userId, userId), isNull(courseMemberships.droppedAt)),
  });
}
