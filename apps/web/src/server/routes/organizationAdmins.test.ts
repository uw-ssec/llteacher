/* #367: Org Admin provisioning routes, against a real database -- the grant
   writes organization_memberships and creates a pending user, so the point is
   what actually lands. */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { makeNodeDb } from "../../db/nodeClient";
import type { Db } from "../../db/client";
import { organizationMemberships, organizations, users } from "../../db/schema";
import { grantOrgAdminHandler, listOrgAdminsHandler, revokeOrgAdminHandler } from "./organizationAdmins";
import type { AppEnv } from "../context";
import type { AuthContext } from "../middleware/roles";
import { fakeAuthContext, fakeMembership } from "../testing/authContext";

const DATABASE_URL = process.env.DATABASE_URL;
const ENC = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
const BLIND = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");

const auditMock = vi.fn();
vi.mock("../utils/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/audit")>()),
  auditBestEffort: (...a: unknown[]) => auditMock(...a),
}));
vi.mock("../../db/client", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../db/client")>();
  const { makeNodeDb: makeNode } = await import("../../db/nodeClient");
  return { ...real, makeDb: (url: string) => makeNode(url) };
});

describe.skipIf(!DATABASE_URL)("Org Admin provisioning (#367, real DB)", () => {
  let db: Db;
  let orgId: string;
  let otherOrgId: string;
  /** A real users row: the grant records who granted it (a uuid FK), so the
   *  caller's session must name a real user, as it always does in production. */
  let granterId: string;
  const ENV = () => ({ DATABASE_URL: DATABASE_URL!, ENCRYPTION_KEY: ENC, BLIND_INDEX_KEY: BLIND }) as Env;

  function app(authContext: AuthContext) {
    const a = new Hono<AppEnv>();
    a.use("*", async (c, next) => {
      c.set("authContext", authContext);
      await next();
    });
    a.get("/api/organizations/:organizationId/admins", (c) => listOrgAdminsHandler(c));
    a.post("/api/organizations/:organizationId/admins", (c) => grantOrgAdminHandler(c));
    a.delete("/api/organizations/:organizationId/admins/:userId", (c) => revokeOrgAdminHandler(c));
    return a;
  }
  const grant = (ctx: AuthContext, org: string, email: string) =>
    app(ctx).request(
      `/api/organizations/${org}/admins`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) },
      ENV(),
    );
  const adminRows = (org: string) =>
    db.select().from(organizationMemberships).where(eq(organizationMemberships.organizationId, org));

  const asGranter = (ctx: AuthContext): AuthContext => ({ ...ctx, session: { ...ctx.session, userId: granterId } });
  const superAdmin = () => asGranter(fakeAuthContext({ isSuperAdmin: true }));
  const orgAdmin = () => asGranter(fakeAuthContext({ orgAdminOrgIds: [orgId] }));
  const instructor = () =>
    asGranter(fakeAuthContext({ memberships: [fakeMembership({ courseId: "c1", role: "instructor" })] }));

  beforeAll(async () => {
    db = makeNodeDb(DATABASE_URL!);
    const make = async (label: string) =>
      (
        await db
          .insert(organizations)
          .values({ slug: `oa-${label}-${crypto.randomUUID()}`, name: label, workosOrganizationId: `w-${crypto.randomUUID()}` })
          .returning({ id: organizations.id })
      )[0]!.id;
    orgId = await make("main");
    otherOrgId = await make("other");
    const [granter] = await db
      .insert(users)
      .values({
        email: crypto.getRandomValues(new Uint8Array(16)) as never,
        emailBlindIndex: crypto.getRandomValues(new Uint8Array(32)) as never,
      })
      .returning({ id: users.id });
    granterId = granter!.id;
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(organizations).where(eq(organizations.id, otherOrgId));
    await db.delete(users).where(eq(users.id, granterId));
  });

  it("lets a super admin bootstrap an organization's first Org Admin, idempotently, and audits it", async () => {
    const email = `first-admin-${crypto.randomUUID()}@uw.edu`;
    const res = await grant(superAdmin(), orgId, email);
    expect(res.status).toBe(201);
    const again = await grant(superAdmin(), orgId, email);
    expect(again.status).toBe(201);
    const rows = await adminRows(orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe("admin");
    expect(auditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ action: "membership.org_admin_granted", targetId: rows[0]!.userId }),
    );

    const list = await app(superAdmin()).request(`/api/organizations/${orgId}/admins`, undefined, ENV());
    const body = (await list.json()) as { admins: { email: string }[] };
    expect(body.admins.map((a) => a.email)).toEqual([email]);
  });

  it("lets an Org Admin grant and revoke within their own organization only", async () => {
    const email = `second-admin-${crypto.randomUUID()}@uw.edu`;
    const res = await grant(orgAdmin(), orgId, email);
    expect(res.status).toBe(201);
    const { userId } = (await res.json()) as { userId: string };

    expect((await grant(orgAdmin(), otherOrgId, `x-${crypto.randomUUID()}@uw.edu`)).status).toBe(403);
    expect(await adminRows(otherOrgId)).toHaveLength(0);

    const revoke = await app(orgAdmin()).request(`/api/organizations/${orgId}/admins/${userId}`, { method: "DELETE" }, ENV());
    expect(revoke.status).toBe(200);
    const remaining = await db
      .select()
      .from(organizationMemberships)
      .where(and(eq(organizationMemberships.organizationId, orgId), eq(organizationMemberships.userId, userId)));
    expect(remaining).toHaveLength(0);
    const again = await app(orgAdmin()).request(`/api/organizations/${orgId}/admins/${userId}`, { method: "DELETE" }, ENV());
    expect(again.status).toBe(404);
  });

  it("refuses a course instructor, who has no organization-level authority", async () => {
    expect((await grant(instructor(), orgId, `y-${crypto.randomUUID()}@uw.edu`)).status).toBe(403);
    expect((await app(instructor()).request(`/api/organizations/${orgId}/admins`, undefined, ENV())).status).toBe(403);
  });

  it("refuses a malformed organization id and an ineligible email", async () => {
    expect((await grant(superAdmin(), "not-a-uuid", `z-${crypto.randomUUID()}@uw.edu`)).status).toBe(403);
    expect((await grant(superAdmin(), orgId, "someone@example.com")).status).toBe(400);
  });
});
