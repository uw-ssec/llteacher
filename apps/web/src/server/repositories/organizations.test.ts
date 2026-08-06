import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { makeNodeDb } from "../../db/nodeClient";
import type { Db } from "../../db/client";
import { organizations, courses } from "../../db/schema";
import { getOrgScopeByWorkosOrgId, getOrgScopeForCourse } from "./organizations";

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

// #161: getOrgScopeForCourse is the tenant-boundary lookup
// updateHomeworkHandler uses to validate a homework's llmConfigId belongs
// to the SAME course's org, not just any org the caller happens to belong
// to (see its docstring for why that distinction matters).
describe.skipIf(!DATABASE_URL)("getOrgScopeForCourse (#161, real DB)", () => {
  let db: Db;
  let orgAId: string;
  let orgBId: string;
  let courseInOrgAId: string;

  beforeAll(async () => {
    db = makeNodeDb(DATABASE_URL!);
    const [orgA] = await db.insert(organizations).values({
      slug: `orgforcourse-a-${crypto.randomUUID()}`, name: "Org A", workosOrganizationId: `w-a-${crypto.randomUUID()}`,
    }).returning({ id: organizations.id });
    orgAId = orgA.id;
    const [orgB] = await db.insert(organizations).values({
      slug: `orgforcourse-b-${crypto.randomUUID()}`, name: "Org B", workosOrganizationId: `w-b-${crypto.randomUUID()}`,
    }).returning({ id: organizations.id });
    orgBId = orgB.id;
    const [course] = await db.insert(courses).values({
      organizationId: orgAId, code: "C", term: "T", title: "Course in Org A",
    }).returning({ id: courses.id });
    courseInOrgAId = course.id;
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgAId));
    await db.delete(organizations).where(eq(organizations.id, orgBId));
  });

  it("resolves the course's own org, not any other org", async () => {
    const scope = await getOrgScopeForCourse(db, courseInOrgAId);
    expect(scope).toBe(orgAId);
    expect(scope).not.toBe(orgBId);
  });

  it("returns null for a nonexistent courseId", async () => {
    const scope = await getOrgScopeForCourse(db, "00000000-0000-0000-0000-000000000000");
    expect(scope).toBeNull();
  });
});
