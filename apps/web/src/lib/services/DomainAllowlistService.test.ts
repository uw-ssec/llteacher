import { describe, it, expect } from "vitest";
import { DomainAllowlistService } from "./DomainAllowlistService";
import type { Db } from "../../db/client";
import type { BlindIndex } from "../../db/types/encrypted";

function fakeBlindIndex(): BlindIndex {
  return new Uint8Array(32) as BlindIndex;
}

describe("DomainAllowlistService.validateEmailDomain", () => {
  it("allows an exact-match domain", () => {
    expect(DomainAllowlistService.validateEmailDomain("cdcore@uw.edu", ["uw.edu"])).toEqual({
      allowed: true,
    });
  });

  it("allows a subdomain of an allowed domain", () => {
    expect(
      DomainAllowlistService.validateEmailDomain("cdcore@cs.uw.edu", ["uw.edu"]).allowed,
    ).toBe(true);
  });

  it("rejects a disallowed domain with a reason", () => {
    const result = DomainAllowlistService.validateEmailDomain("cdcore@gmail.com", ["uw.edu"]);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/gmail\.com/);
  });

  it("rejects malformed email", () => {
    expect(DomainAllowlistService.validateEmailDomain("not-an-email", ["uw.edu"]).allowed).toBe(
      false,
    );
  });

  it("is case-insensitive", () => {
    expect(DomainAllowlistService.validateEmailDomain("cdcore@UW.EDU", ["uw.edu"]).allowed).toBe(
      true,
    );
  });
});

describe("DomainAllowlistService.checkGrandfathering", () => {
  it("returns true for an existing, non-pending user", async () => {
    const db = {
      query: { users: { findFirst: async () => ({ id: "u1", isPending: false }) } },
    } as unknown as Db;
    expect(await DomainAllowlistService.checkGrandfathering(fakeBlindIndex(), db)).toBe(true);
  });

  it("returns false when no user matches", async () => {
    const db = { query: { users: { findFirst: async () => undefined } } } as unknown as Db;
    expect(await DomainAllowlistService.checkGrandfathering(fakeBlindIndex(), db)).toBe(false);
  });

  it("returns false for a pending (roster-only) user", async () => {
    const db = {
      query: { users: { findFirst: async () => ({ id: "u1", isPending: true }) } },
    } as unknown as Db;
    expect(await DomainAllowlistService.checkGrandfathering(fakeBlindIndex(), db)).toBe(false);
  });
});

describe("DomainAllowlistService.resolveAllowedDomains", () => {
  it("returns the org's allowedDomains when the org is found", async () => {
    const db = {
      query: {
        organizations: {
          findFirst: async () => ({ id: "org1", allowedDomains: ["cs.uw.edu", "uw.edu"] }),
        },
      },
    } as unknown as Db;
    expect(await DomainAllowlistService.resolveAllowedDomains("workos_org_1", db)).toEqual([
      "cs.uw.edu",
      "uw.edu",
    ]);
  });

  it("falls back to the default when organizationId is undefined (single-tenant dev)", async () => {
    const db = { query: { organizations: { findFirst: async () => undefined } } } as unknown as Db;
    expect(await DomainAllowlistService.resolveAllowedDomains(undefined, db)).toEqual(
      DomainAllowlistService.DEFAULT_ALLOWED_DOMAINS,
    );
  });

  it("falls back to the default when no org matches the workosOrganizationId", async () => {
    const db = { query: { organizations: { findFirst: async () => undefined } } } as unknown as Db;
    expect(await DomainAllowlistService.resolveAllowedDomains("unknown_org", db)).toEqual(
      DomainAllowlistService.DEFAULT_ALLOWED_DOMAINS,
    );
  });

  it("falls back to the default when the org row has an empty allowedDomains array", async () => {
    const db = {
      query: { organizations: { findFirst: async () => ({ id: "org1", allowedDomains: [] }) } },
    } as unknown as Db;
    expect(await DomainAllowlistService.resolveAllowedDomains("workos_org_1", db)).toEqual(
      DomainAllowlistService.DEFAULT_ALLOWED_DOMAINS,
    );
  });
});
