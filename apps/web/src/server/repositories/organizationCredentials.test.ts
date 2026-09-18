/* --------------------------------------------------------------------------
   #73: the Canvas token credential store.

   Real-DB, for the same reason the sibling roster/llmConfigs suites are:
   the design rests on organization_credentials_org_provider_label_uq
   making "set" a real upsert, and on the encrypted_secret round-trip
   actually decrypting to what was written -- a mock would pass either
   way without exercising the bytea column or the check constraint.
   -------------------------------------------------------------------------- */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeNodeDb } from "../../db/nodeClient";
import type { Db } from "../../db/client";
import { organizations } from "../../db/schema";
import { unsafeOrgScope } from "./scope";
import {
  deleteCanvasCredential,
  getCanvasCredentialSummary,
  getDecryptedCanvasCredential,
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

  beforeAll(async () => {
    db = makeNodeDb(DATABASE_URL!);
    cipher = new IdentityCipher(
      await loadIdentityCipherKeys({
        ENCRYPTION_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
        BLIND_INDEX_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
      } as Env),
    );
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
    await deleteCanvasCredential(db, unsafeOrgScope(orgAId));
    await deleteCanvasCredential(db, unsafeOrgScope(orgBId));
  });

  it("returns null when no credential has been set", async () => {
    const summary = await getCanvasCredentialSummary(db, cipher, unsafeOrgScope(orgAId));
    expect(summary).toBeNull();
  });

  it("round-trips the token through encryption and returns a masked summary", async () => {
    const scope = unsafeOrgScope(orgAId);
    await setCanvasCredential(db, cipher, scope, {
      token: "canvas-token-1234567890",
      canvasBaseUrl: "https://uw.instructure.com",
      expiresAt: null,
    });

    const summary = await getCanvasCredentialSummary(db, cipher, scope);
    expect(summary).not.toBeNull();
    expect(summary!.maskedToken).toBe(maskToken("canvas-token-1234567890"));
    expect(summary!.canvasBaseUrl).toBe("https://uw.instructure.com");
    expect(summary!.rotatedAt).not.toBeNull();

    const decrypted = await getDecryptedCanvasCredential(db, cipher, scope);
    expect(decrypted!.token).toBe("canvas-token-1234567890");

    // The plaintext token itself must never appear in the masked summary.
    expect(JSON.stringify(summary)).not.toContain("canvas-token-1234567890");
  });

  it("replaces the existing token on a second set, rather than creating a second row", async () => {
    const scope = unsafeOrgScope(orgBId);
    await setCanvasCredential(db, cipher, scope, {
      token: "first-token-aaaaaaaa",
      canvasBaseUrl: "https://uw.instructure.com",
      expiresAt: null,
    });
    const firstRotatedAt = (await getCanvasCredentialSummary(db, cipher, scope))!.rotatedAt;

    await new Promise((resolve) => setTimeout(resolve, 5));
    await setCanvasCredential(db, cipher, scope, {
      token: "second-token-bbbbbbbb",
      canvasBaseUrl: "https://canvas.washington.edu",
      expiresAt: null,
    });

    const decrypted = await getDecryptedCanvasCredential(db, cipher, scope);
    expect(decrypted!.token).toBe("second-token-bbbbbbbb");
    expect(decrypted!.canvasBaseUrl).toBe("https://canvas.washington.edu");

    const summary = await getCanvasCredentialSummary(db, cipher, scope);
    expect(summary!.rotatedAt).not.toBe(firstRotatedAt);
  });

  it("is scoped per organization -- org A's credential is invisible under org B's scope", async () => {
    await setCanvasCredential(db, cipher, unsafeOrgScope(orgAId), {
      token: "org-a-only-token",
      canvasBaseUrl: "https://uw.instructure.com",
      expiresAt: null,
    });
    const [otherOrg] = await db
      .insert(organizations)
      .values({ slug: `oc-c-${crypto.randomUUID()}`, name: "C", workosOrganizationId: `w-c-${crypto.randomUUID()}` })
      .returning({ id: organizations.id });

    const summary = await getCanvasCredentialSummary(db, cipher, unsafeOrgScope(otherOrg!.id));
    expect(summary).toBeNull();
  });

  it("deletes the credential; a second delete reports nothing to remove", async () => {
    const scope = unsafeOrgScope(orgAId);
    await setCanvasCredential(db, cipher, scope, {
      token: "to-be-deleted",
      canvasBaseUrl: "https://uw.instructure.com",
      expiresAt: null,
    });

    const first = await deleteCanvasCredential(db, scope);
    expect(first.deleted).toBe(true);

    const summary = await getCanvasCredentialSummary(db, cipher, scope);
    expect(summary).toBeNull();

    const second = await deleteCanvasCredential(db, scope);
    expect(second.deleted).toBe(false);
  });
});
