// Branded string types so a repository method that expects an OrgScope or
// CourseScope rejects a raw string at compile time. Construct one only from
// a value already verified to belong to the caller (e.g. AuthContext
// membership, or a row just read back from the DB) -- these functions do
// zero validation, they only change the type.

declare const OrgScopeBrand: unique symbol;
declare const CourseScopeBrand: unique symbol;

export type OrgScope = string & { readonly [OrgScopeBrand]: true };
export type CourseScope = string & { readonly [CourseScopeBrand]: true };

// "unsafe": zero validation, just a type-level cast. Only call these with a
// value already verified to belong to the caller -- a row just read back
// from the DB under an already-verified scope, or a test fixture. Nothing
// stops route code from calling these with unvalidated request input and
// having it typecheck identically to a real scope (found in PR #127 review,
// #135) -- route code should mint via courseScopeFromAuthContext() below
// instead, which can't produce a scope without a verified membership check.
export function unsafeOrgScope(organizationId: string): OrgScope {
  return organizationId as OrgScope;
}

export function unsafeCourseScope(courseId: string): CourseScope {
  return courseId as CourseScope;
}

// The only sanctioned way for route code to mint a CourseScope: verifies
// the caller is actually a member of courseId before returning one, instead
// of trusting the caller to have checked already. Takes a minimal
// structural type (not the full AuthContext) to avoid a repositories ->
// server/middleware import; rolesMiddleware populates isMemberOf from a
// real DB membership lookup (repositories/users.ts), so this check is only
// as good as that data being current for the request.
//
// No equivalent orgScopeFromAuthContext yet: AuthContext's memberships are
// CourseMembership rows, which don't carry organization_id directly (only
// reachable via a course -> organization join), and there's no production
// route today that mints an OrgScope from request context to justify
// building that join. Add one if/when such a route lands.
export function courseScopeFromAuthContext(
  authContext: { isMemberOf(courseId: string): boolean },
  courseId: string,
): CourseScope | null {
  return authContext.isMemberOf(courseId) ? unsafeCourseScope(courseId) : null;
}
