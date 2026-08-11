/** Course role vocabulary shared by apps/web and apps/admin.
 *
 *  The authoritative definition is the `course_role` Postgres enum
 *  (apps/web/src/db/schema/identity.ts) -- this is a hand-kept mirror
 *  because apps/admin's build cannot import apps/web's server-side Drizzle
 *  schema across the app boundary, and both apps already depend on
 *  @llteacher/ui. apps/web/src/lib/courseRoleParity.test.ts asserts the
 *  two stay in sync. */
export const COURSE_ROLES = ["instructor", "ta", "student", "observer", "admin"] as const;

export type CourseRole = (typeof COURSE_ROLES)[number];

/** Runtime-validates an untrusted value (e.g. a field off a fetch response)
 *  against the known role vocabulary. Returns null for anything else --
 *  including a value the schema legitimately returned that this mirror
 *  hasn't caught up to yet -- so callers deny by default instead of
 *  trusting an uncast-through string. */
export function parseCourseRole(value: unknown): CourseRole | null {
  return typeof value === "string" && (COURSE_ROLES as readonly string[]).includes(value)
    ? (value as CourseRole)
    : null;
}

/* ---------------------------------------------------------------------------
   Authority tiers (#172)

   These live here, beside COURSE_ROLES, for the same reason COURSE_ROLES
   does: apps/admin gates its UI on them and apps/web enforces them, and the
   two disagreeing is precisely the defect #172 exists to fix (a console
   offering controls whose requests 403). Hand-mirroring them in each app
   made that a comment; importing one definition makes it a mechanism.
   courseRoleParity.test.ts asserts the tiers stay coherent with the enum.
   --------------------------------------------------------------------------- */

/** May author course content: create/edit/delete/publish/hide a homework.
 *  Deliberately excludes `ta` -- a TA is a grader, not an author. */
export const AUTHOR_ROLES = ["instructor", "admin"] as const satisfies readonly CourseRole[];

/** May read student work for grading: the submissions dashboard and an
 *  individual student's section answer. Strictly a superset of
 *  AUTHOR_ROLES -- every author is a grader, not every grader is an author. */
export const GRADER_ROLES = ["instructor", "admin", "ta"] as const satisfies readonly CourseRole[];

/** Roles admitted to the admin console at all. Identical to GRADER_ROLES
 *  today and aliased rather than re-listed, so "who may open the console"
 *  and "who may read student work" cannot drift apart silently. */
export const CONSOLE_ROLES = GRADER_ROLES;

export function isAuthorRole(role: CourseRole): boolean {
  return (AUTHOR_ROLES as readonly CourseRole[]).includes(role);
}

export function isGraderRole(role: CourseRole): boolean {
  return (GRADER_ROLES as readonly CourseRole[]).includes(role);
}

/** The per-membership capabilities an instructor grants a TA, course by
 *  course.
 *
 *  Scope of this list, stated honestly: it is the source of the
 *  `TaCapabilityField` type and the set `resolveTaCapabilities` iterates, so
 *  those two cannot fall out of step with each other. It is NOT a
 *  single-edit switch for adding a third capability -- that still needs a
 *  migration, a column in the Drizzle schema, a predicate on AuthContext, a
 *  body validator in routes/courseMemberships.ts, and a column entry in
 *  TaCapabilitiesView. An earlier version of this comment claimed adding one
 *  was "a migration plus one entry here"; it was not, and nothing consumed
 *  this array at all. */
export const TA_CAPABILITY_FIELDS = ["canViewSolutions", "canViewDrafts"] as const;

export type TaCapabilityField = (typeof TA_CAPABILITY_FIELDS)[number];

export type TaCapabilityFlags = Record<TaCapabilityField, boolean>;

/** The single definition of "who holds which capability".
 *
 *  Authors hold everything unconditionally -- the stored flags describe a
 *  TA's grant and are meaningless on any other role, so they are never
 *  consulted for an author and never honored for a student or observer.
 *
 *  Every consumer calls this rather than restating it: rolesMiddleware for
 *  request-time enforcement, ProfileService for the shape apps/admin
 *  renders from, and the AuthContext test double. Three hand-written copies
 *  is how the client and server drift apart.
 *
 *  The stored flags are REQUIRED, not `Partial` (#172 re-audit, MNT-009).
 *  With Partial, a caller handing in a membership object that simply lacked
 *  the columns -- a projection that forgot them, a test double, a row read
 *  before 0019 applied -- type-checked cleanly and resolved every capability
 *  to false. A silently-denied TA is a support ticket nobody can reproduce;
 *  a compile error is not. */
export function resolveTaCapabilities(
  membership: { role: CourseRole } & TaCapabilityFlags,
): TaCapabilityFlags {
  const authors = isAuthorRole(membership.role);
  const held = (field: TaCapabilityField) =>
    authors || (membership.role === "ta" && membership[field] === true);
  // Iterates TA_CAPABILITY_FIELDS rather than restating the two names, so
  // the array above is load-bearing rather than decorative.
  return Object.fromEntries(
    TA_CAPABILITY_FIELDS.map((field) => [field, held(field)]),
  ) as TaCapabilityFlags;
}
