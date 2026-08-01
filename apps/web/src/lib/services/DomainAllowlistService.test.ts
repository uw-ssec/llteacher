import { describe, it, expect } from "vitest";
import { DomainAllowlistService } from "./DomainAllowlistService";
import type { Db } from "../../db/client";
import type { BlindIndex } from "../../db/types/encrypted";

function fakeBlindIndex(): BlindIndex {
  return new Uint8Array(32) as BlindIndex;
}

/** findFirst is called in a fixed order by checkGrandfathering: first by
 *  workosUserId, then (only if that misses/is pending) by emailBlindIndex.
 *  Tests supply results for each call in that order via a queue. Mirrors
 *  UserIdentityService.test.ts's queuedFindFirst helper. */
function queuedFindFirst(...results: unknown[]): () => Promise<unknown> {
  const queue = [...results];
  return async () => queue.shift();
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
  it("returns true for an existing, non-pending user found by workosUserId", async () => {
    const db = {
      query: { users: { findFirst: queuedFindFirst({ id: "u1", isPending: false }) } },
    } as unknown as Db;
    expect(
      await DomainAllowlistService.checkGrandfathering("workos_1", fakeBlindIndex(), db),
    ).toBe(true);
  });

  it("returns false when no user matches either lookup", async () => {
    const db = {
      query: { users: { findFirst: queuedFindFirst(undefined, undefined) } },
    } as unknown as Db;
    expect(
      await DomainAllowlistService.checkGrandfathering("workos_1", fakeBlindIndex(), db),
    ).toBe(false);
  });

  it("returns false for a pending (roster-only) user found by both lookups", async () => {
    const db = {
      query: {
        users: {
          findFirst: queuedFindFirst({ id: "u1", isPending: true }, { id: "u1", isPending: true }),
        },
      },
    } as unknown as Db;
    expect(
      await DomainAllowlistService.checkGrandfathering("workos_1", fakeBlindIndex(), db),
    ).toBe(false);
  });

  it("grandfathers an existing user by workosUserId even when their new email's blind index matches no row, and short-circuits (does not query by email)", async () => {
    let findFirstCalls = 0;
    const db = {
      query: {
        users: {
          findFirst: async () => {
            findFirstCalls++;
            return { id: "existing-user-1", isPending: false };
          },
        },
      },
    } as unknown as Db;

    const result = await DomainAllowlistService.checkGrandfathering(
      "workos_1",
      fakeBlindIndex(),
      db,
    );

    expect(result).toBe(true);
    expect(findFirstCalls).toBe(1);
  });

  it("falls back to the emailBlindIndex lookup when no user matches workosUserId", async () => {
    const db = {
      query: {
        users: {
          findFirst: queuedFindFirst(undefined, { id: "existing-user-2", isPending: false }),
        },
      },
    } as unknown as Db;

    expect(
      await DomainAllowlistService.checkGrandfathering("unknown_workos_id", fakeBlindIndex(), db),
    ).toBe(true);
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

  it("falls back to the default (does not throw) when the organizations lookup errors -- e.g. a missing migration column", async () => {
    const db = {
      query: {
        organizations: {
          findFirst: async () => {
            throw new Error('column "allowed_domains" does not exist');
          },
        },
      },
    } as unknown as Db;
    await expect(
      DomainAllowlistService.resolveAllowedDomains("workos_org_1", db),
    ).resolves.toEqual(DomainAllowlistService.DEFAULT_ALLOWED_DOMAINS);
  });
});
