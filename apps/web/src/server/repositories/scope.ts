// Branded string types so a repository method that expects an OrgScope or
// CourseScope rejects a raw string at compile time. Construct one only from
// a value already verified to belong to the caller (e.g. AuthContext
// membership, or a row just read back from the DB) -- these functions do
// zero validation, they only change the type.

declare const OrgScopeBrand: unique symbol;
declare const CourseScopeBrand: unique symbol;

export type OrgScope = string & { readonly [OrgScopeBrand]: true };
export type CourseScope = string & { readonly [CourseScopeBrand]: true };

export function orgScope(organizationId: string): OrgScope {
  return organizationId as OrgScope;
}

export function courseScope(courseId: string): CourseScope {
  return courseId as CourseScope;
}
