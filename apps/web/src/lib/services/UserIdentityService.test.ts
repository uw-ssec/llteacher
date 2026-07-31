import { describe, it, expect, beforeAll } from "vitest";
import { IdentityCipher, type IdentityCipherKeys } from "../crypto/identity-cipher";
import { UserIdentityService } from "./UserIdentityService";
import type { Db } from "../../db/client";

let keys: IdentityCipherKeys;

beforeAll(async () => {
  keys = {
    encryptionKey: (await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
      "encrypt",
      "decrypt",
    ])) as CryptoKey,
    blindIndexKey: (await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, true, [
      "sign",
    ])) as CryptoKey,
    encryptionKeyId: "k1",
  };
});

const WORKOS_USER = { id: "workos_1", email: "cdcore@uw.edu", firstName: "Cordero" };

describe("UserIdentityService.createOrClaimUser", () => {
  it("creates a new user with encrypted email (not plaintext)", async () => {
    const cipher = new IdentityCipher(keys);
    const insertedValues: Record<string, unknown>[] = [];
    const db = {
      query: { users: { findFirst: async () => undefined } },
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          insertedValues.push(v);
          return { returning: async () => [{ id: "new-user-1" }] };
        },
      }),
    } as unknown as Db;

    const result = await new UserIdentityService(cipher, db).createOrClaimUser(WORKOS_USER);

    expect(result).toEqual({ userId: "new-user-1", isNew: true });
    expect(insertedValues).toHaveLength(1);
    const storedEmail = insertedValues[0].email as Uint8Array;
    expect(Buffer.from(storedEmail).includes("cdcore@uw.edu")).toBe(false);
    expect(await cipher.decryptString(storedEmail as never)).toBe("cdcore@uw.edu");
  });

  it("repeat login finds the same user by email blind index, no duplicate insert", async () => {
    const cipher = new IdentityCipher(keys);
    let insertCalls = 0;
    let updatedValues: Record<string, unknown> | undefined;
    const db = {
      query: {
        users: {
          findFirst: async () => ({ id: "existing-user-1", isPending: false }),
        },
      },
      insert: () => {
        insertCalls++;
        return { values: () => ({ returning: async () => [{ id: "should-not-happen" }] }) };
      },
      update: () => ({
        set: (v: Record<string, unknown>) => {
          updatedValues = v;
          return { where: async () => undefined };
        },
      }),
    } as unknown as Db;

    const result = await new UserIdentityService(cipher, db).createOrClaimUser(WORKOS_USER);

    expect(result).toEqual({ userId: "existing-user-1", isNew: false });
    expect(insertCalls).toBe(0);
    expect(updatedValues?.lastLoginAt).toBeInstanceOf(Date);
  });

  it("claims a pending (roster-provisioned) user instead of creating a duplicate", async () => {
    const cipher = new IdentityCipher(keys);
    let updatedValues: Record<string, unknown> | undefined;
    const db = {
      query: {
        users: {
          findFirst: async () => ({ id: "pending-user-1", isPending: true }),
        },
      },
      update: () => ({
        set: (v: Record<string, unknown>) => {
          updatedValues = v;
          return { where: async () => undefined };
        },
      }),
    } as unknown as Db;

    const result = await new UserIdentityService(cipher, db).createOrClaimUser(WORKOS_USER);

    expect(result).toEqual({ userId: "pending-user-1", isNew: false });
    expect(updatedValues?.isPending).toBe(false);
    expect(updatedValues?.workosUserId).toBe("workos_1");
    expect(await cipher.decryptString(updatedValues?.email as never)).toBe("cdcore@uw.edu");
  });
});

describe("UserIdentityService.decryptUserForDisplay", () => {
  it("round-trips encrypted email and display name", async () => {
    const cipher = new IdentityCipher(keys);
    const db = {} as unknown as Db;
    const row = {
      id: "u1",
      email: await cipher.encryptString("cdcore@uw.edu"),
      displayName: await cipher.encryptString("Cordero"),
    };
    const displayed = await new UserIdentityService(cipher, db).decryptUserForDisplay(
      row as never,
    );
    expect(displayed).toEqual({ id: "u1", email: "cdcore@uw.edu", displayName: "Cordero" });
  });

  it("returns null displayName when the row has none", async () => {
    const cipher = new IdentityCipher(keys);
    const db = {} as unknown as Db;
    const row = { id: "u1", email: await cipher.encryptString("cdcore@uw.edu"), displayName: null };
    const displayed = await new UserIdentityService(cipher, db).decryptUserForDisplay(
      row as never,
    );
    expect(displayed.displayName).toBeNull();
  });
});
