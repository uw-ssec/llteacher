import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { courseMemberships, homeworks, users } from "../../db/schema";
import type { Db } from "../../db/client";
import type { IdentityCipher } from "../crypto/identity-cipher";
import type { CourseRole } from "../../server/middleware/roles";
import { CONSOLE_ROLES, resolveTaCapabilities } from "@llteacher/ui/auth/courseRole";
import type { ProfileWithStats } from "../../shared/types";

/** `count(*)::int` -- Postgres returns bigint for count(), which the driver
 *  hands back as a string; the ::int cast keeps it a number. */
const sqlCount = () => sql<number>`count(*)::int`;

/** Highest-privilege-first ordering used to derive a deterministic
 *  "primary role" for a user with multiple course memberships. Postgres
 *  gives no row-ordering guarantee without an explicit ORDER BY, so picking
 *  `memberships[0]` would make the primary role flicker across requests for
 *  any multi-role user (e.g. instructor in one course, student in another).
 *
 *  `satisfies Record<CourseRole, number>` makes this exhaustive against the
 *  enum at compile time -- adding a role to course_role without ranking it
 *  here fails to compile, instead of the new role silently never being
 *  selected as primary.
 *
 *  #202 (MNT-023): sqlCount was inserted between this doc comment and the
 *  declaration it describes, so the doc attached to sqlCount and this
 *  constant read as undocumented. Moved rather than duplicated. */
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

/** Roles admitted to the admin console, and therefore to the `courses`
 *  stopgap field below (#21 Resolved Design Decision 8). Kept separate from
 *  ROLE_PRIORITY_RANK because that ranking answers a different question
 *  ("which single role wins as primary") than this one ("which memberships
 *  may open the console at all").
 *
 *  #198 (#172 re-audit, MNT-021): named CONSOLE_TIER_ROLES, not
 *  INSTRUCTOR_TIER_ROLES, and this really matters. It is literally
 *  `new Set(CONSOLE_ROLES)`, which INCLUDES `ta` -- but the old name and the
 *  old doc ("which memberships count as course-editing access") both said
 *  the opposite, and a TA having no course-editing access is the central
 *  premise of #172. A consumer of `profile.courses` who trusted either would
 *  conclude the array is pre-filtered to editable courses and skip the
 *  per-entry role check, showing a TA authoring affordances for a course
 *  they assist on. This array is WIDER than authoring: gate each entry on
 *  its own `role`, never on membership in this set. */
const CONSOLE_TIER_ROLES: ReadonlySet<CourseRole> = new Set(CONSOLE_ROLES);

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
    // #172 audit (SCL-001/CMP-004/FUN-004): explicitly ordered. apps/admin
    // treats courses[0] as the active course and, since #172, derives
    // `canAuthor` from its role -- so an unordered result made an
    // authorization posture nondeterministic across requests. Postgres
    // guarantees no row order without ORDER BY, and this file already makes
    // exactly that argument for ROLE_PRIORITY above.
    //
    // #172 re-audit (FUN-103): most recent enrollment FIRST, and the
    // `courses` projection below is then re-sorted authority-first. The
    // first fix used `asc(enrolledAt)`, which made a real case
    // *consistently* broken instead of intermittently so: a grad student
    // who TA'd in an earlier term and now instructs their own course got
    // their oldest membership as courses[0] on every request, so canAuthor
    // was false everywhere, the authoring nav was hidden, and -- with no
    // course switcher until #70 -- they had no way to reach the course they
    // actually run. Determinism was necessary but not sufficient; it also
    // has to land on the right course.
    //
    // #172 audit (FUN-007): droppedAt filtered in SQL rather than in JS
    // below, so `primaryRole` and `courseCount` stop counting memberships a
    // user no longer holds -- a dropped TA was passing the console's role
    // gate and landing on an empty-course state instead of a 403.
    const memberships = await this.db.query.courseMemberships.findMany({
      where: and(eq(courseMemberships.userId, userId), isNull(courseMemberships.droppedAt)),
      with: { course: true },
      orderBy: (m, { desc, asc }) => [desc(m.enrolledAt), asc(m.id)],
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

    // #199 (#172 re-audit, MNT-022): a set membership test, not a literal
    // disjunction restating the console tier 60 lines below the set that
    // already imports it from @llteacher/ui. This is the outer gate deciding
    // whether `profile.courses` is populated at all, so when a fourth console
    // role lands -- and App.test.tsx already exercises an unrecognized role
    // arriving from a newer server -- a hand-written list here would leave
    // that user with an empty courses array, canAuthor false, and the console
    // showing "No course found for your account yet" for someone who has
    // courses. Silent, in the auth path, and failing no test.
    if (primaryRole !== null && CONSOLE_TIER_ROLES.has(primaryRole)) {
      // #172 audit (SCL-003): a COUNT aggregate rather than loading every
      // homework row across every membership to read `.length`. At one
      // course the difference is invisible; at fifty it is the piece that
      // turns a slow profile into a console that will not load, and
      // `canAuthor` defaults to false when courses is empty -- so a timed
      // out profile silently renders an instructor as a non-author.
      const membershipIds = memberships.map((m) => m.id);
      const [homeworkCount] = membershipIds.length
        ? await this.db
            .select({ count: sqlCount() })
            .from(homeworks)
            .where(inArray(homeworks.createdById, membershipIds))
        : [{ count: 0 }];
      profile.instructorStats = { homeworksCreated: Number(homeworkCount?.count ?? 0) };
      // Stopgap for apps/admin's course context until #70's real course
      // switcher lands (see docs/superpowers/plans/2026-08-05-m3-homeworks-
      // submissions-parity.md, Resolved Design Decision 8). Per-membership
      // role/droppedAt filter (not just the overall primaryRole gate above)
      // because a multi-course user can be an instructor in one course and
      // merely a student/observer in another -- only the former should
      // appear here.
      // #172: each entry carries the caller's role in *that* course plus the
      // resolved capabilities, so apps/admin can gate per course instead of
      // on the priority-ranked primaryRole above.
      //
      // Capabilities come from @llteacher/ui's resolveTaCapabilities -- the
      // same function rolesMiddleware enforces with. An earlier version
      // re-derived the rule here and claimed in this comment that resolving
      // server-side stopped the client drifting; that only moved the drift
      // risk from client-vs-server to server-vs-server. Calling the shared
      // resolver is what actually removes it.
      //
      // Authority-first, then most-recent (#172 re-audit, FUN-103). Array
      // sort is stable, so within a tier the SQL `desc(enrolledAt)` ordering
      // above survives. This is what guarantees that a user who instructs
      // *anywhere* gets an authoring course as courses[0] -- the console's
      // active course -- rather than whichever course they happened to join
      // most recently. It uses ROLE_PRIORITY_RANK rather than a second
      // hand-written ordering so "which role outranks which" has one answer
      // in this file.
      profile.courses = memberships
        .filter((m) => CONSOLE_TIER_ROLES.has(m.role))
        .map((m) => ({
          id: m.course.id,
          title: m.course.title,
          role: m.role,
          ...resolveTaCapabilities(m),
        }))
        .sort((a, b) => ROLE_PRIORITY_RANK[a.role] - ROLE_PRIORITY_RANK[b.role]);
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
