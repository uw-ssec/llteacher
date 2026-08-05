import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { makeNodeDb } from "../../db/nodeClient";
import type { Db } from "../../db/client";
import { organizations } from "../../db/schema";
import { getOrgScopeByWorkosOrgId } from "./organizations";

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)("getOrgScopeByWorkosOrgId (#147, real DB)", () => {
  let db: Db;
  let orgId: string;
  const workosOrgId = `w-${crypto.randomUUID()}`;

  beforeAll(async () => {
    db = makeNodeDb(DATABASE_URL!);
    const [org] = await db
      .insert(organizations)
      .values({ slug: `orgbyworkos-${crypto.randomUUID()}`, name: "Test Org", workosOrganizationId: workosOrgId })
      .returning({ id: organizations.id });
    orgId = org.id;
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  it("resolves the local org scope for a matching WorkOS organization id", async () => {
    const scope = await getOrgScopeByWorkosOrgId(db, workosOrgId);
    expect(scope).toBe(orgId);
  });

  it("returns null for a WorkOS organization id with no matching local row", async () => {
    const scope = await getOrgScopeByWorkosOrgId(db, `w-unknown-${crypto.randomUUID()}`);
    expect(scope).toBeNull();
  });

  it("returns null when no organizationId was present at all", async () => {
    const scope = await getOrgScopeByWorkosOrgId(db, undefined);
    expect(scope).toBeNull();
  });
});
