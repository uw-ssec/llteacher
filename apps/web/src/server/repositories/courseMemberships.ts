import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../../db/client";
import { courseMemberships } from "../../db/schema";
import type { CourseScope } from "./scope";

/** #172: one TA's standing in a course, as the instructor-facing capability
 *  UI needs it. `userId` rather than any identifying field -- names/emails
 *  are encrypted and decrypting a roster is the submissions dashboard's job
 *  (it already builds an IdentityCipher for exactly that); this endpoint
 *  stays a thin capability read. */
export interface CourseTaCapabilities {
  membershipId: string;
  userId: string;
  canViewSolutions: boolean;
  canViewDrafts: boolean;
}

/** Lists the course's non-dropped TA memberships. Course-scoped, never
 *  org-scoped: the caller is authorized on one course, so the query is
 *  constrained by the same key (#174's lesson). */
export async function listCourseTas(db: Db, scope: CourseScope): Promise<CourseTaCapabilities[]> {
  const rows = await db
    .select({
      membershipId: courseMemberships.id,
      userId: courseMemberships.userId,
      canViewSolutions: courseMemberships.canViewSolutions,
      canViewDrafts: courseMemberships.canViewDrafts,
    })
    .from(courseMemberships)
    .where(
      and(
        eq(courseMemberships.courseId, scope),
        eq(courseMemberships.role, "ta"),
        isNull(courseMemberships.droppedAt),
      ),
    );
  return rows;
}

/** Sets one or both capability flags on a TA membership.
 *
 *  The `role = 'ta'` and `courseId = scope` predicates are part of the WHERE,
 *  not a read-then-write check, so a membership in another course -- or an
 *  instructor's own membership -- simply matches zero rows and returns null
 *  rather than being updated. That closes the same authorize-on-one-key /
 *  write-by-another gap #174 found on the read side, and avoids a
 *  check-then-act race.
 *
 *  Returns null when no such TA membership exists in this course; the route
 *  maps that to 404. Only the flags named in `input` are written, so a
 *  partial update never silently clears the other capability. */
export async function setTaCapabilities(
  db: Db,
  scope: CourseScope,
  membershipId: string,
  input: { canViewSolutions?: boolean; canViewDrafts?: boolean },
): Promise<CourseTaCapabilities | null> {
  const fields = {
    ...(input.canViewSolutions !== undefined && { canViewSolutions: input.canViewSolutions }),
    ...(input.canViewDrafts !== undefined && { canViewDrafts: input.canViewDrafts }),
  };
  if (Object.keys(fields).length === 0) {
    // Nothing to write -- read back instead of issuing an UPDATE with an
    // empty SET, which Drizzle rejects at runtime.
    const [found] = await db
      .select({
        membershipId: courseMemberships.id,
        userId: courseMemberships.userId,
        canViewSolutions: courseMemberships.canViewSolutions,
        canViewDrafts: courseMemberships.canViewDrafts,
      })
      .from(courseMemberships)
      .where(
        and(
          eq(courseMemberships.id, membershipId),
          eq(courseMemberships.courseId, scope),
          eq(courseMemberships.role, "ta"),
          isNull(courseMemberships.droppedAt),
        ),
      );
    return found ?? null;
  }

  const [updated] = await db
    .update(courseMemberships)
    .set({ ...fields, updatedAt: new Date() })
    .where(
      and(
        eq(courseMemberships.id, membershipId),
        eq(courseMemberships.courseId, scope),
        eq(courseMemberships.role, "ta"),
        isNull(courseMemberships.droppedAt),
      ),
    )
    .returning({
      membershipId: courseMemberships.id,
      userId: courseMemberships.userId,
      canViewSolutions: courseMemberships.canViewSolutions,
      canViewDrafts: courseMemberships.canViewDrafts,
    });
  return updated ?? null;
}
