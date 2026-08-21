/* --------------------------------------------------------------------------
   #210: NetID format validation.

   The asymmetry this file exists to pin: a rejected valid NetID is visible
   and recoverable (the instructor sees which entry was refused and why), an
   accepted invalid one mints a pending user that permanently squats a
   uniquely-indexed netid_blind_index. So the interesting cases here are the
   junk that must NOT be accepted, not the happy path.
   -------------------------------------------------------------------------- */

import { describe, it, expect } from "vitest";
import { isValidNetid, emailForNetid, NETID_RULE_MESSAGE } from "./netid";
import { IdentityCipher } from "./crypto/identity-cipher";

describe("isValidNetid (#210)", () => {
  for (const netid of ["a", "cdcore", "ada2", "abcdefgh", "j1234567"]) {
    it(`accepts ${netid}`, () => expect(isValidNetid(netid)).toBe(true));
  }

  for (const [label, value] of [
    ["a whole email address pasted in", "cdcore@uw.edu"],
    ["a name with a space", "ada lovelace"],
    ["over 8 characters", "abcdefghi"],
    ["a leading digit", "1ada"],
    ["empty", ""],
    ["a hyphen (administrative/shared IDs are not people)", "joe-admin"],
    ["an underscore", "ada_l"],
    ["a dot", "ada.l"],
    ["uppercase reaching the check unnormalized", "ADA"],
    ["surrounding whitespace reaching the check unnormalized", " ada "],
  ] as const) {
    it(`rejects ${label}`, () => expect(isValidNetid(value)).toBe(false));
  }

  it("accepts what normalizeNetid produces from messy but valid input", () => {
    // The last two rejections above are the reason this pairing matters:
    // the pattern deliberately does not re-do normalization, so every caller
    // must normalize first. addTasByNetid does.
    expect(isValidNetid(IdentityCipher.normalizeNetid("  ADA  "))).toBe(true);
  });

  it("states the rule rather than only saying the entry is invalid", () => {
    // Per-NetID results are only useful if they say what to fix.
    expect(NETID_RULE_MESSAGE).toMatch(/1–8|1-8/);
    expect(NETID_RULE_MESSAGE).toMatch(/letter/i);
  });
});

describe("emailForNetid (#210)", () => {
  it("produces the address deriveNetid maps back from", () => {
    // The round trip is what lets createOrClaimUser claim the pending row by
    // email blind index on first AuthKit login.
    expect(emailForNetid("cdcore")).toBe("cdcore@uw.edu");
    expect(IdentityCipher.normalizeEmail(emailForNetid("cdcore")).split("@")[0]).toBe("cdcore");
  });
});
