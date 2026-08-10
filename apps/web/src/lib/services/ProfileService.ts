import { eq, inArray } from "drizzle-orm";
import { courseMemberships, homeworks, users } from "../../db/schema";
import type { Db } from "../../db/client";
import type { IdentityCipher } from "../crypto/identity-cipher";
import type { CourseRole } from "../../server/middleware/roles";
import type { ProfileWithStats } from "../../shared/types";

/** Highest-privilege-first ordering used to derive a deterministic
 *  "primary role" for a user with multiple course memberships. Postgres
 *  gives no row-ordering guarantee without an explicit ORDER BY, so picking
 *  `memberships[0]` would make the primary role flicker across requests for
 *  any multi-role user (e.g. instructor in one course, student in another).
 *
 *  `satisfies Record<CourseRole, number>` makes this exhaustive against the
 *  enum at compile time -- adding a role to course_role without ranking it
 *  here fails to compile, instead of the new role silently never being
 *  selected as primary. */
const ROLE_PRIORITY_RANK = {
  admin: 0,
  instructor: 1,
  ta: 2,
  student: 3,
  observer: 4,
} satisfies Record<CourseRole, number>;

const ROLE_PRIORITY = (Object.keys(ROLE_PRIORITY_RANK) as CourseRole[]).sort(
  (a, b) => ROLE_PRIORITY_RANK[a] - ROLE_PRIORITY_RANK[b],
);

/** Roles that make a membership "instructor-tier" for the purposes of the
 *  `courses` stopgap field below (#21 Resolved Design Decision 8) -- kept
 *  separate from ROLE_PRIORITY_RANK because that ranking answers a
 *  different question ("which single role wins as primary") than this one
 *  ("which memberships count as course-editing access"). */
const INSTRUCTOR_TIER_ROLES: ReadonlySet<CourseRole> = new Set(["instructor", "ta", "admin"]);

export class ProfileService {
  constructor(
    private readonly cipher: IdentityCipher,
    private readonly db: Db,
  ) {}

  async getProfileWithStats(userId: string): Promise<ProfileWithStats> {
    const user = await this.db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }

    const email = await this.cipher.decryptString(user.email);
    const displayName = user.displayName
      ? await this.cipher.decryptString(user.displayName)
      : null;

    // `with: { course: true }` pulls each membership's course row (id/title)
    // in the same query via Drizzle's relational API, rather than a second
    // hand-rolled select+join -- it reuses the courseMembershipsRelations
    // already defined in db/schema/identity.ts and keeps this file on the
    // same `db.query.*` style as every other lookup here.
    const memberships = await this.db.query.courseMemberships.findMany({
      where: eq(courseMemberships.userId, userId),
      with: { course: true },
    });
    const primaryRole =
      ROLE_PRIORITY.find((role) => memberships.some((m) => m.role === role)) ?? null;

    const profile: ProfileWithStats = {
      userId: user.id,
      email,
      displayName,
      role: primaryRole,
      courseCount: memberships.length,
    };

    if (primaryRole === "instructor" || primaryRole === "ta" || primaryRole === "admin") {
      const membershipIds = memberships.map((m) => m.id);
      const createdHomeworks = membershipIds.length
        ? await this.db.query.homeworks.findMany({
            where: inArray(homeworks.createdById, membershipIds),
          })
        : [];
      profile.instructorStats = { homeworksCreated: createdHomeworks.length };
      // Stopgap for apps/admin's course context until #70's real course
      // switcher lands (see docs/superpowers/plans/2026-08-05-m3-homeworks-
      // submissions-parity.md, Resolved Design Decision 8). Per-membership
      // role/droppedAt filter (not just the overall primaryRole gate above)
      // because a multi-course user can be an instructor in one course and
      // merely a student/observer in another -- only the former should
      // appear here.
      // #172: each entry carries the caller's role in *that* course plus the
      // resolved capabilities, so apps/admin can gate per course instead of
      // on the priority-ranked primaryRole above. Capabilities are resolved
      // here (instructor/admin unconditional, `ta` per grant) rather than
      // shipping the raw columns, so the client can't drift from the
      // server's own AuthContext.canViewSolutionsIn/canViewDraftsIn rule.
      profile.courses = memberships
        .filter((m) => INSTRUCTOR_TIER_ROLES.has(m.role) && !m.droppedAt)
        .map((m) => {
          const authors = m.role === "instructor" || m.role === "admin";
          return {
            id: m.course.id,
            title: m.course.title,
            role: m.role,
            canViewSolutions: authors || (m.role === "ta" && m.canViewSolutions),
            canViewDrafts: authors || (m.role === "ta" && m.canViewDrafts),
          };
        });
    } else if (primaryRole === "student") {
      // TODO: real submission/completion counts once the conversation +
      // submission tables land (multi-tenant-data-model.md §6.3, M2). No
      // per-student runtime data exists in the schema yet -- issues
      // #12/#13 explicitly gate this on M2. Both fields are stubbed
      // together (rather than omitting completedSections) so the response
      // type honestly reflects what M1 can compute today.
      profile.studentStats = { submissionsCount: 0, completedSections: 0 };
    }

    return profile;
  }

  async updateDisplayName(
    userId: string,
    newDisplayName: string,
  ): Promise<{ displayName: string }> {
    const encrypted = await this.cipher.encryptString(newDisplayName);
    await this.db
      .update(users)
      .set({ displayName: encrypted, updatedAt: new Date() })
      .where(eq(users.id, userId));
    return { displayName: newDisplayName };
  }
}
