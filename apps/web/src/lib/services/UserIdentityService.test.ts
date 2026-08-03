import { describe, it, expect, beforeAll } from "vitest";
import { IdentityCipher, type IdentityCipherKeys } from "../crypto/identity-cipher";
import { UserIdentityService } from "./UserIdentityService";
import { courseMemberships } from "../../db/schema";
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

/** findFirst is called in a fixed order by createOrClaimUser: first by
 *  workosUserId, then (only if that misses) by emailBlindIndex. Tests
 *  supply results for each call in that order via a queue. */
function queuedFindFirst(...results: unknown[]): () => Promise<unknown> {
  const queue = [...results];
  return async () => queue.shift();
}

describe("UserIdentityService.createOrClaimUser", () => {
  it("creates a new user with encrypted email and a derived netid (not plaintext)", async () => {
    const cipher = new IdentityCipher(keys);
    const insertedValues: Record<string, unknown>[] = [];
    const db = {
      query: { users: { findFirst: queuedFindFirst(undefined, undefined) } },
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

    const storedNetid = insertedValues[0].netid as Uint8Array;
    expect(await cipher.decryptString(storedNetid as never)).toBe("cdcore");
    expect(insertedValues[0].netidBlindIndex).toBeInstanceOf(Uint8Array);
  });

  it("does not derive a netid for a non-uw.edu (grandfathered) domain", async () => {
    const cipher = new IdentityCipher(keys);
    const insertedValues: Record<string, unknown>[] = [];
    const db = {
      query: { users: { findFirst: queuedFindFirst(undefined, undefined) } },
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          insertedValues.push(v);
          return { returning: async () => [{ id: "new-user-2" }] };
        },
      }),
    } as unknown as Db;

    await new UserIdentityService(cipher, db).createOrClaimUser({
      id: "workos_2",
      email: "cdcore@gmail.com",
      firstName: "Cordero",
    });

    expect(insertedValues[0].netid).toBeNull();
    expect(insertedValues[0].netidBlindIndex).toBeNull();
  });

  it("repeat login (same workosUserId) finds the same user, no duplicate insert", async () => {
    const cipher = new IdentityCipher(keys);
    const encryptedEmail = await cipher.encryptString("cdcore@uw.edu");
    let insertCalls = 0;
    let updatedValues: Record<string, unknown> | undefined;
    const db = {
      query: {
        users: {
          findFirst: queuedFindFirst({
            id: "existing-user-1",
            isPending: false,
            email: encryptedEmail,
            netidBlindIndex: new Uint8Array(32),
          }),
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
    // Email on WorkOS's side is unchanged, and netidBlindIndex is already
    // set -- no re-encryption needed for either field.
    expect(updatedValues?.email).toBeUndefined();
    expect(updatedValues?.netid).toBeUndefined();
  });

  it("re-encrypts email when it changed on the WorkOS side since the last login", async () => {
    const cipher = new IdentityCipher(keys);
    const staleEncryptedEmail = await cipher.encryptString("old-address@uw.edu");
    let updatedValues: Record<string, unknown> | undefined;
    const db = {
      query: {
        users: {
          findFirst: queuedFindFirst({
            id: "existing-user-1",
            isPending: false,
            email: staleEncryptedEmail,
            netidBlindIndex: new Uint8Array(32),
          }),
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

    expect(result).toEqual({ userId: "existing-user-1", isNew: false });
    expect(await cipher.decryptString(updatedValues?.email as never)).toBe("cdcore@uw.edu");
    expect(updatedValues?.emailBlindIndex).toBeInstanceOf(Uint8Array);
  });

  it("does NOT attempt a duplicate insert when the WorkOS email changed (unique constraint safe)", async () => {
    const cipher = new IdentityCipher(keys);
    const staleEncryptedEmail = await cipher.encryptString("old-address@uw.edu");
    let insertCalls = 0;
    const db = {
      query: {
        users: {
          findFirst: queuedFindFirst({
            id: "existing-user-1",
            isPending: false,
            email: staleEncryptedEmail,
            netidBlindIndex: new Uint8Array(32),
          }),
        },
      },
      insert: () => {
        insertCalls++;
        return { values: () => ({ returning: async () => [{ id: "should-not-happen" }] }) };
      },
      update: () => ({ set: () => ({ where: async () => undefined }) }),
    } as unknown as Db;

    await new UserIdentityService(cipher, db).createOrClaimUser(WORKOS_USER);
    expect(insertCalls).toBe(0);
  });

  it("claims a pending (roster-provisioned) user by email, instead of creating a duplicate", async () => {
    const cipher = new IdentityCipher(keys);
    let updatedValues: Record<string, unknown> | undefined;
    const db = {
      query: {
        users: {
          findFirst: queuedFindFirst(undefined, { id: "pending-user-1", isPending: true }),
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
    expect(await cipher.decryptString(updatedValues?.netid as never)).toBe("cdcore");
  });

  it("email change onto a pending row's address merges memberships and deletes the pending row", async () => {
    const cipher = new IdentityCipher(keys);
    const staleEncryptedEmail = await cipher.encryptString("old-address@uw.edu");
    const membershipUpdates: Record<string, unknown>[] = [];
    const membershipDeletes: unknown[] = [];
    const userDeletes: unknown[] = [];
    let finalUserUpdate: Record<string, unknown> | undefined;

    const pendingMembership = { id: "m-pending-only", courseId: "course-A" };
    const duplicateMembership = { id: "m-duplicate", courseId: "course-B" };
    const existingMembership = { id: "m-existing", courseId: "course-B" };

    const db = {
      query: {
        users: {
          findFirst: queuedFindFirst(
            {
              id: "existing-user-1",
              isPending: false,
              email: staleEncryptedEmail,
              netidBlindIndex: new Uint8Array(32),
            },
            { id: "pending-user-1", isPending: true },
          ),
        },
        courseMemberships: {
          findMany: queuedFindFirst([pendingMembership, duplicateMembership], [
            existingMembership,
          ]),
        },
      },
      update: (table: unknown) => {
        if (table === courseMemberships) {
          return {
            set: (v: Record<string, unknown>) => ({
              where: async () => {
                membershipUpdates.push(v);
              },
            }),
          };
        }
        return {
          set: (v: Record<string, unknown>) => {
            finalUserUpdate = v;
            return { where: async () => undefined };
          },
        };
      },
      delete: (table: unknown) => ({
        where: async () => {
          if (table === courseMemberships) membershipDeletes.push(table);
          else userDeletes.push(table);
        },
      }),
    } as unknown as Db;

    const result = await new UserIdentityService(cipher, db).createOrClaimUser({
      id: "workos_1",
      email: "newname@uw.edu",
      firstName: "Cordero",
    });

    expect(result).toEqual({ userId: "existing-user-1", isNew: false });
    // course-A only existed on the pending row -- moved onto existing-user-1.
    expect(membershipUpdates).toEqual([{ userId: "existing-user-1" }]);
    // course-B existed on both -- the pending row's duplicate is dropped,
    // not the row that already had it.
    expect(membershipDeletes).toHaveLength(1);
    // Pending row itself is deleted last.
    expect(userDeletes).toHaveLength(1);
    expect(await cipher.decryptString(finalUserUpdate?.email as never)).toBe("newname@uw.edu");
    expect(finalUserUpdate?.emailBlindIndex).toBeInstanceOf(Uint8Array);
  });

  it("email change onto an address already owned by a non-pending user keeps the old email and still logs in", async () => {
    const cipher = new IdentityCipher(keys);
    const staleEncryptedEmail = await cipher.encryptString("old-address@uw.edu");
    let finalUserUpdate: Record<string, unknown> | undefined;

    const db = {
      query: {
        users: {
          findFirst: queuedFindFirst(
            {
              id: "existing-user-1",
              isPending: false,
              email: staleEncryptedEmail,
              netidBlindIndex: new Uint8Array(32),
            },
            { id: "other-user-2", isPending: false },
          ),
        },
      },
      update: () => ({
        set: (v: Record<string, unknown>) => {
          finalUserUpdate = v;
          return { where: async () => undefined };
        },
      }),
    } as unknown as Db;

    const result = await new UserIdentityService(cipher, db).createOrClaimUser({
      id: "workos_1",
      email: "newname@uw.edu",
      firstName: "Cordero",
    });

    expect(result).toEqual({ userId: "existing-user-1", isNew: false });
    expect(finalUserUpdate?.email).toBeUndefined();
    expect(finalUserUpdate?.emailBlindIndex).toBeUndefined();
    expect(finalUserUpdate?.lastLoginAt).toBeInstanceOf(Date);
  });
});
