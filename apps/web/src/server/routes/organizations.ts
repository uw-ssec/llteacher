import type { Context } from "hono";
import type { CreateOrganizationBody, OrganizationResponse } from "@llteacher/ui/api";
import { makeDb } from "../../db/client";
import type { AppEnv } from "../context";
import type { AuthContext } from "../middleware/roles";
import { createDeploymentOrganization, getDeploymentOrganization } from "../repositories/organizations";
import { unsafeOrgScope } from "../repositories/scope";
import { AUDIT_ACTIONS, AUDIT_TARGET_TYPES, auditBestEffort } from "../utils/audit";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function superAdmin(c: Context<AppEnv>): AuthContext | null {
  const auth = c.get("authContext") as AuthContext | undefined;
  return auth?.isSuperAdmin ? auth : null;
}

export async function getOrganizationHandler(c: Context<AppEnv>) {
  if (!superAdmin(c)) return c.json({ error: "Super admin access required" }, 403);
  const organization = await getDeploymentOrganization(makeDb(c.env.DATABASE_URL));
  return c.json({ organization } satisfies OrganizationResponse);
}

export async function createOrganizationHandler(c: Context<AppEnv>) {
  const auth = superAdmin(c);
  if (!auth) return c.json({ error: "Super admin access required" }, 403);
  let raw: unknown;
  try { raw = await c.req.json(); } catch { return c.json({ error: "Request body must be valid JSON" }, 400); }
  if (!raw || typeof raw !== "object") return c.json({ error: "Invalid organization" }, 400);
  const body = raw as Partial<CreateOrganizationBody>;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const slug = typeof body.slug === "string" ? body.slug.trim().toLowerCase() : "";
  const domains = Array.isArray(body.allowedDomains)
    ? [...new Set(body.allowedDomains.filter((v): v is string => typeof v === "string").map((v) => v.trim().toLowerCase()))]
    : [];
  if (!name || !SLUG.test(slug) || domains.length === 0 || domains.some((d) => !DOMAIN.test(d))) {
    return c.json({ error: "Name, a URL-safe slug, and at least one valid domain are required" }, 400);
  }
  const db = makeDb(c.env.DATABASE_URL);
  const result = await createDeploymentOrganization(db, {
    name, slug, allowedDomains: domains, workosOrganizationId: auth.session.workosOrganizationId,
  });
  if (!result.created) {
    return result.organization
      ? c.json({ error: "This deployment is already initialized", organization: result.organization }, 409)
      : c.json({ error: "Organization name, slug, or identity conflicts with an existing record" }, 409);
  }
  await auditBestEffort(db, [unsafeOrgScope(result.organization.id)], {
    actorUserId: auth.session.userId,
    action: AUDIT_ACTIONS.ORGANIZATION_INITIALIZED,
    targetType: AUDIT_TARGET_TYPES.ORGANIZATION,
    targetId: result.organization.id,
  });
  return c.json({ organization: result.organization } satisfies OrganizationResponse, 201);
}
