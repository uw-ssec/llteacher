import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { organizations } from "../../db/schema";
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
