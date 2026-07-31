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
