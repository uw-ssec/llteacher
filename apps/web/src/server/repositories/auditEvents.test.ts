import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { makeNodeDb } from "../../db/nodeClient";
import type { Db } from "../../db/client";
import { organizations, users, auditEvents } from "../../db/schema";
import { unsafeOrgScope } from "./scope";
import { recordAuditEvent } from "./auditEvents";

const DATABASE_URL = process.env.DATABASE_URL;

// #149: recordAuditEvent had zero test coverage despite the Phase-4 commit
// claiming cross-org isolation tests for every repository it added. It does
// have a real caller today (#95's webhooksWorkos.ts, mocked in that file's
// own unit tests) -- this fills the real-DB gap: does the write actually
// land under the given scope, and does a scoped read never cross orgs.
// #147 will add more callers (auth/profile handlers); this write path and
// its scoping are exercised here independent of who calls it.
describe.skipIf(!DATABASE_URL)("auditEvents repository", () => {
  let db: Db;
  let orgAId: string;
  let orgBId: string;
  let actorUserId: string;

  beforeAll(async () => {
    db = makeNodeDb(DATABASE_URL!);
    const [orgA] = await db
      .insert(organizations)
      .values({ slug: `audit-a-${crypto.randomUUID()}`, name: "A", workosOrganizationId: `w-a-${crypto.randomUUID()}` })
      .returning({ id: organizations.id });
    orgAId = orgA.id;
    const [orgB] = await db
      .insert(organizations)
      .values({ slug: `audit-b-${crypto.randomUUID()}`, name: "B", workosOrganizationId: `w-b-${crypto.randomUUID()}` })
      .returning({ id: organizations.id });
    orgBId = orgB.id;

    const emailBytes = crypto.getRandomValues(new Uint8Array(32));
    const [actor] = await db
      .insert(users)
      .values({ email: emailBytes as never, emailBlindIndex: emailBytes as never })
      .returning({ id: users.id });
    actorUserId = actor.id;
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgAId));
    await db.delete(organizations).where(eq(organizations.id, orgBId));
    await db.delete(users).where(eq(users.id, actorUserId));
  });

  it("writes a row under the given org scope with the given actor/action/target", async () => {
    const targetId = crypto.randomUUID();
    const created = await recordAuditEvent(db, unsafeOrgScope(orgAId), {
      actorUserId,
      action: "test.action",
      targetType: "test",
      targetId,
    });
    expect(created.organizationId).toBe(orgAId);
    expect(created.actorUserId).toBe(actorUserId);
    expect(created.action).toBe("test.action");
    expect(created.targetId).toBe(targetId);
  });

  it("allows a null actorUserId (system-initiated event)", async () => {
    const created = await recordAuditEvent(db, unsafeOrgScope(orgAId), {
      actorUserId: null,
      action: "test.system-action",
      targetType: "test",
      targetId: crypto.randomUUID(),
    });
    expect(created.actorUserId).toBeNull();
  });

  // Mutation-check: writes to both orgs first, then reads back scoped to
  // org B and asserts the org-A row's id is absent -- if a caller queried
  // audit_events without an organizationId filter, org A's row would leak
  // into this result.
  it("a read scoped to org B never includes an event recorded under org A", async () => {
    const eventA = await recordAuditEvent(db, unsafeOrgScope(orgAId), {
      actorUserId: null,
      action: "isolation.test",
      targetType: "test",
      targetId: crypto.randomUUID(),
    });
    const eventB = await recordAuditEvent(db, unsafeOrgScope(orgBId), {
      actorUserId: null,
      action: "isolation.test",
      targetType: "test",
      targetId: crypto.randomUUID(),
    });

    const orgBRows = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.organizationId, orgBId), eq(auditEvents.action, "isolation.test")));

    const ids = orgBRows.map((r) => r.id);
    expect(ids).toContain(eventB.id);
    expect(ids).not.toContain(eventA.id);
  });
});
