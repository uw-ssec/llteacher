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
