import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { organizations, courses } from "../../db/schema";
import type { OrganizationPayload } from "@llteacher/ui/api";
import { unsafeOrgScope, type OrgScope } from "./scope";

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

export async function getOrgScopeForCourse(db: Db, courseId: string): Promise<OrgScope | null> {
  const course = await db.query.courses.findFirst({
    where: eq(courses.id, courseId),
    columns: { organizationId: true },
  });
  return course ? unsafeOrgScope(course.organizationId) : null;
}

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

export async function listAllOrgScopes(db: Db): Promise<OrgScope[]> {
  const rows = await db.select({ id: organizations.id }).from(organizations);
  return rows.map((row) => unsafeOrgScope(row.id));
}

function payload(row: typeof organizations.$inferSelect): OrganizationPayload {
  return { id: row.id, name: row.name, slug: row.slug, allowedDomains: row.allowedDomains };
}

export async function getDeploymentOrganization(db: Db): Promise<OrganizationPayload | null> {
  const row = await db.query.organizations.findFirst({
    where: eq(organizations.deploymentSingleton, true),
  });
  return row ? payload(row) : null;
}

export async function createDeploymentOrganization(
  db: Db,
  input: {
    name: string;
    slug: string;
    allowedDomains: string[];
    workosOrganizationId?: string;
  },
): Promise<{ created: boolean; organization: OrganizationPayload }> {
  const rows = await db.insert(organizations).values({
    name: input.name,
    deploymentSingleton: true,
    slug: input.slug,
    allowedDomains: input.allowedDomains,
    workosOrganizationId: input.workosOrganizationId,
  }).onConflictDoNothing().returning();
  if (rows[0]) return { created: true, organization: payload(rows[0]) };
  const existing = await getDeploymentOrganization(db);
  if (!existing) throw new Error("Organization initialization conflicted without an existing row");
  return { created: false, organization: existing };
}
