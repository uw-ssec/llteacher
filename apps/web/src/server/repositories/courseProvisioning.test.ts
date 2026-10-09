import { describe, expect, it, vi } from "vitest";
import type { Db } from "../../db/client";
import type { IdentityCipher } from "../../lib/crypto/identity-cipher";
import { addInstructorToCourse } from "./courseProvisioning";

describe("addInstructorToCourse email validation", () => {
  it.each([
    "prof@.uw.edu",
    "prof@sub..uw.edu",
    "first..last@uw.edu",
    "prof()@uw.edu",
    "prof@-sub.uw.edu",
  ])("rejects malformed %s before entering the write transaction", async (email) => {
    const transaction = vi.fn(async () => ({ status: "assigned" }));
    const db = {
      query: {
        organizations: { findFirst: async () => ({ id: "org-1", allowedDomains: ["uw.edu"] }) },
      },
      transaction,
    } as unknown as Db;
    const cipher = {
      computeBlindIndex: vi.fn(async () => new Uint8Array(32)),
      encryptString: vi.fn(async () => new Uint8Array(32)),
    } as unknown as IdentityCipher;

    expect(await addInstructorToCourse(db, cipher, "actor-1", "course-1", email))
      .toMatchObject({ status: "invalid_email" });
    expect(transaction).not.toHaveBeenCalled();
  });
});
