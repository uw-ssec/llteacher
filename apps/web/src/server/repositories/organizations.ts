import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { organizations, courses } from "../../db/schema";
import { unsafeOrgScope, type OrgScope } from "./scope";

/** Resolves the local `organizations` row for a WorkOS organization id --
 *  the same lookup DomainAllowlistService does internally for the
 *  allowlist policy, exposed here for the audit-event call sites in
 *  routes/auth.ts (#147): a login/provisioning event has no course
 *  membership yet to derive an org scope from (that's what
 *  getOrgScopesForUser, repositories/users.ts, is for post-membership
 *  actions like logout/profile-update), but the WorkOS auth response's
 *  organizationId is available at that point. Returns null if no
 *  organizationId was present on the auth response, or no local row
 *  matches it yet (single-tenant v0 dev path) -- callers skip the audit
 *  write rather than guessing a scope. */
export async function getOrgScopeByWorkosOrgId(
  db: Db,
  workosOrganizationId: string | undefined,
): Promise<OrgScope | null> {
  if (!workosOrganizationId) return null;
  const org = await db.query.organizations.findFirst({
    where: eq(organizations.workosOrganizationId, workosOrganizationId),
    columns: { id: true },
  });
  return org ? unsafeOrgScope(org.id) : null;
}

/** Resolves the org a specific course belongs to. #161: deliberately
 *  scoped to this one course, not getOrgScopesForUser's full list of every
 *  org the caller belongs to -- an instructor with memberships in two
 *  different organizations (a real case: WorkOS orgs are independent
 *  tenants, and course_memberships carries no cross-org uniqueness
 *  constraint) would otherwise be able to point course A's homework (org
 *  A) at an llmConfig from org B, since both orgs are "one of their own".
 *  Returns null if courseId doesn't exist. */
export async function getOrgScopeForCourse(db: Db, courseId: string): Promise<OrgScope | null> {
  const course = await db.query.courses.findFirst({
    where: eq(courses.id, courseId),
    columns: { organizationId: true },
  });
  return course ? unsafeOrgScope(course.organizationId) : null;
}

/** #317 review, #346 (requirement 1): the org-scope + course-level LLM
 *  config override in one round-trip, for chat.ts's two conversation-
 *  creation branches (resolveConversation's own doc comment) -- the only
 *  callers that don't already have a `courses` row's llmConfigId for free
 *  from an earlier join. Kept separate from getOrgScopeForCourse above
 *  (not a widened return type on that function) because that function has
 *  many callers that want only the org scope and have no reason to pull in
 *  a lib/llm-config.ts-shaped column alongside it. */
export async function getOrgScopeAndLlmConfigForCourse(
  db: Db,
  courseId: string,
): Promise<{ orgScope: OrgScope; courseLlmConfigId: string | null } | null> {
  const course = await db.query.courses.findFirst({
    where: eq(courses.id, courseId),
    columns: { organizationId: true, llmConfigId: true },
  });
  return course ? { orgScope: unsafeOrgScope(course.organizationId), courseLlmConfigId: course.llmConfigId } : null;
}
