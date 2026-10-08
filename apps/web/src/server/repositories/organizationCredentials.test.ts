/* --------------------------------------------------------------------------
   #73: the Canvas token credential store.

   Real-DB, for the same reason the sibling roster/llmConfigs suites are:
   the design rests on the partial owner/provider/label index making "set"
   a real per-instructor upsert, and on the encrypted_secret round-trip
   actually decrypting to what was written -- a mock would pass either way
   without exercising the bytea column, ownership index, or check constraint.
   -------------------------------------------------------------------------- */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { makeNodeDb } from "../../db/nodeClient";
import type { Db } from "../../db/client";
import { organizationCredentials, organizations, users } from "../../db/schema";
import { unsafeOrgScope } from "./scope";
import {
  CANVAS_CREDENTIAL_LABEL,
  deleteCanvasCredential,
  getCanvasCredentialSummary,
  getDecryptedCanvasCredential,
  getDecryptedCanvasCredentialById,
  hasLegacyCanvasCredential,
  maskToken,
  setCanvasCredential,
} from "./organizationCredentials";
import { loadIdentityCipherKeys } from "../../lib/secrets-loader";
import { IdentityCipher } from "../../lib/crypto/identity-cipher";

describe("maskToken", () => {
  it("keeps the first 2 and last 2 characters", () => {
    expect(maskToken("1234~abcdefghijklmnop~1234567890")).toBe("12••••90");
  });

  it("masks a short token entirely rather than risk revealing it", () => {
    expect(maskToken("abcd")).toBe("••••");
    expect(maskToken("ab")).toBe("••••");
  });
});

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)("organizationCredentials (#73)", () => {
  let db: Db;
  let cipher: IdentityCipher;
  let orgAId: string;
  let orgBId: string;
  let orgCId: string | undefined;
  let ownerAId: string;
  let ownerBId: string;

  beforeAll(async () => {
    db = makeNodeDb(DATABASE_URL!);
    cipher = new IdentityCipher(
      await loadIdentityCipherKeys({
        ENCRYPTION_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
        BLIND_INDEX_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
      } as Env),
    );
    const [ownerA] = await db.insert(users).values({
      email: await cipher.encryptString("owner-a@uw.edu"),
      emailBlindIndex: await cipher.computeBlindIndex(`owner-a-${crypto.randomUUID()}@uw.edu`),
      isPending: true,
    }).returning({ id: users.id });
    ownerAId = ownerA!.id;
    const [ownerB] = await db.insert(users).values({
      email: await cipher.encryptString("owner-b@uw.edu"),
      emailBlindIndex: await cipher.computeBlindIndex(`owner-b-${crypto.randomUUID()}@uw.edu`),
      isPending: true,
    }).returning({ id: users.id });
    ownerBId = ownerB!.id;
    const [orgA] = await db
      .insert(organizations)
      .values({ slug: `oc-a-${crypto.randomUUID()}`, name: "A", workosOrganizationId: `w-a-${crypto.randomUUID()}` })
      .returning({ id: organizations.id });
    orgAId = orgA!.id;
    const [orgB] = await db
      .insert(organizations)
      .values({ slug: `oc-b-${crypto.randomUUID()}`, name: "B", workosOrganizationId: `w-b-${crypto.randomUUID()}` })
      .returning({ id: organizations.id });
    orgBId = orgB!.id;
  });

  afterAll(async () => {
    await db.delete(organizationCredentials).where(eq(organizationCredentials.organizationId, orgAId));
    await db.delete(organizationCredentials).where(eq(organizationCredentials.organizationId, orgBId));
    if (orgCId) {
      await db.delete(organizationCredentials).where(eq(organizationCredentials.organizationId, orgCId));
      await db.delete(organizations).where(eq(organizations.id, orgCId));
    }
    await db.delete(organizations).where(eq(organizations.id, orgAId));
    await db.delete(organizations).where(eq(organizations.id, orgBId));
    await db.delete(users).where(eq(users.id, ownerAId));
    await db.delete(users).where(eq(users.id, ownerBId));
  });

  it("returns null when no credential has been set", async () => {
    const summary = await getCanvasCredentialSummary(db, cipher, unsafeOrgScope(orgAId), ownerAId);
    expect(summary).toBeNull();
  });

  it("round-trips the token through encryption and returns a masked summary", async () => {
    const scope = unsafeOrgScope(orgAId);
    await setCanvasCredential(db, cipher, scope, ownerAId, {
      token: "canvas-token-1234567890",
      canvasBaseUrl: "https://uw.instructure.com",
      expiresAt: null,
    });

    const summary = await getCanvasCredentialSummary(db, cipher, scope, ownerAId);
    expect(summary).not.toBeNull();
    expect(summary!.maskedToken).toBe(maskToken("canvas-token-1234567890"));
    expect(summary!.canvasBaseUrl).toBe("https://uw.instructure.com");
    expect(summary!.rotatedAt).not.toBeNull();

    const decrypted = await getDecryptedCanvasCredential(db, cipher, scope, ownerAId);
    expect(decrypted!.token).toBe("canvas-token-1234567890");

    // The plaintext token itself must never appear in the masked summary.
    expect(JSON.stringify(summary)).not.toContain("canvas-token-1234567890");
  });

  it("replaces the existing token on a second set, rather than creating a second row", async () => {
    const scope = unsafeOrgScope(orgBId);
    await setCanvasCredential(db, cipher, scope, ownerBId, {
      token: "first-token-aaaaaaaa",
      canvasBaseUrl: "https://uw.instructure.com",
      expiresAt: null,
    });
    const firstRotatedAt = (await getCanvasCredentialSummary(db, cipher, scope, ownerBId))!.rotatedAt;

    await new Promise((resolve) => setTimeout(resolve, 5));
    await setCanvasCredential(db, cipher, scope, ownerBId, {
      token: "second-token-bbbbbbbb",
      canvasBaseUrl: "https://canvas.washington.edu",
      expiresAt: null,
    });

    const decrypted = await getDecryptedCanvasCredential(db, cipher, scope, ownerBId);
    expect(decrypted!.token).toBe("second-token-bbbbbbbb");
    expect(decrypted!.canvasBaseUrl).toBe("https://canvas.washington.edu");

    const summary = await getCanvasCredentialSummary(db, cipher, scope, ownerBId);
    expect(summary!.rotatedAt).not.toBe(firstRotatedAt);
  });

  it("is scoped per organization -- org A's credential is invisible under org B's scope", async () => {
    await setCanvasCredential(db, cipher, unsafeOrgScope(orgAId), ownerAId, {
      token: "org-a-only-token",
      canvasBaseUrl: "https://uw.instructure.com",
      expiresAt: null,
    });
    const [otherOrg] = await db
      .insert(organizations)
      .values({ slug: `oc-c-${crypto.randomUUID()}`, name: "C", workosOrganizationId: `w-c-${crypto.randomUUID()}` })
      .returning({ id: organizations.id });
    orgCId = otherOrg!.id;

    const summary = await getCanvasCredentialSummary(db, cipher, unsafeOrgScope(otherOrg!.id), ownerAId);
    expect(summary).toBeNull();
  });

  it("does not reveal or decrypt one instructor's credential for another instructor", async () => {
    const scope = unsafeOrgScope(orgAId);
    const { id } = await setCanvasCredential(db, cipher, scope, ownerAId, {
      token: "owner-a-private-token",
      canvasBaseUrl: "https://uw.instructure.com",
      expiresAt: null,
    });

    expect(await getCanvasCredentialSummary(db, cipher, scope, ownerBId)).toBeNull();
    expect(await getDecryptedCanvasCredential(db, cipher, scope, ownerBId)).toBeNull();
    expect(await getDecryptedCanvasCredentialById(db, cipher, scope, ownerBId, id)).toBeNull();
  });

  it("reports an ownerless legacy token but never assigns or decrypts it for an instructor", async () => {
    const scope = unsafeOrgScope(orgAId);
    await db.insert(organizationCredentials).values({
      organizationId: orgAId,
      ownerUserId: null,
      provider: "canvas",
      label: CANVAS_CREDENTIAL_LABEL,
      encryptedSecret: await cipher.encryptString("legacy-organization-token"),
      canvasBaseUrl: "https://uw.instructure.com",
    });

    expect(await hasLegacyCanvasCredential(db, scope)).toBe(true);
    expect(await getCanvasCredentialSummary(db, cipher, scope, ownerBId)).toBeNull();
    expect(await getDecryptedCanvasCredential(db, cipher, scope, ownerBId)).toBeNull();
  });

  it("deletes the credential; a second delete reports nothing to remove", async () => {
    const scope = unsafeOrgScope(orgAId);
    await setCanvasCredential(db, cipher, scope, ownerAId, {
      token: "to-be-deleted",
      canvasBaseUrl: "https://uw.instructure.com",
      expiresAt: null,
    });

    const first = await deleteCanvasCredential(db, scope, ownerAId);
    expect(first.deleted).toBe(true);

    const summary = await getCanvasCredentialSummary(db, cipher, scope, ownerAId);
    expect(summary).toBeNull();

    const second = await deleteCanvasCredential(db, scope, ownerAId);
    expect(second.deleted).toBe(false);
  });
});
