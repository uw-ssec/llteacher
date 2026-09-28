import { describe, it, expect } from "vitest";
import { SuperAdminService } from "./SuperAdminService";
import { IdentityCipher } from "../crypto/identity-cipher";
import { loadIdentityCipherKeys } from "../secrets-loader";

async function testCipher(): Promise<IdentityCipher> {
  return new IdentityCipher(
    await loadIdentityCipherKeys({
      ENCRYPTION_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
      BLIND_INDEX_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
    } as Env),
  );
}

describe("SuperAdminService", () => {
  it("lists the configured super admins as a plain, readable array", () => {
    expect(SuperAdminService.SUPER_ADMIN_EMAILS).toEqual(["ksdani@uw.edu", "cdcore@uw.edu"]);
  });

  it("matches a configured super admin's blind index", async () => {
    const cipher = await testCipher();
    const admins = await SuperAdminService.blindIndexes(cipher);
    const userIndex = await cipher.computeBlindIndex(IdentityCipher.normalizeEmail("ksdani@uw.edu"));
    expect(SuperAdminService.isSuperAdmin(userIndex, admins)).toBe(true);
  });

  it("matches regardless of case or surrounding whitespace, same as normalizeEmail", async () => {
    const cipher = await testCipher();
    const admins = await SuperAdminService.blindIndexes(cipher);
    const userIndex = await cipher.computeBlindIndex(
      IdentityCipher.normalizeEmail("  CDCore@UW.EDU  "),
    );
    expect(SuperAdminService.isSuperAdmin(userIndex, admins)).toBe(true);
  });

  it("does not match an unrelated email", async () => {
    const cipher = await testCipher();
    const admins = await SuperAdminService.blindIndexes(cipher);
    const userIndex = await cipher.computeBlindIndex(IdentityCipher.normalizeEmail("student@uw.edu"));
    expect(SuperAdminService.isSuperAdmin(userIndex, admins)).toBe(false);
  });

  it("does not match under a different blind-index key (no cross-tenant/cross-key confusion)", async () => {
    const cipherA = await testCipher();
    const cipherB = await testCipher();
    const admins = await SuperAdminService.blindIndexes(cipherA);
    const userIndex = await cipherB.computeBlindIndex(IdentityCipher.normalizeEmail("ksdani@uw.edu"));
    expect(SuperAdminService.isSuperAdmin(userIndex, admins)).toBe(false);
  });
});
