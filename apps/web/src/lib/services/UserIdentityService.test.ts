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
          return { returning: async () => [{ id: "new-user-1", sessionEpoch: 0 }] };
        },
      }),
    } as unknown as Db;

    const result = await new UserIdentityService(cipher, db).createOrClaimUser(WORKOS_USER);

    expect(result).toEqual({ userId: "new-user-1", isNew: true, sessionEpoch: 0 });
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
          return { returning: async () => [{ id: "new-user-2", sessionEpoch: 0 }] };
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
            isActive: true,
            sessionEpoch: 3,
            email: encryptedEmail,
            netidBlindIndex: new Uint8Array(32),
          }),
        },
      },
      insert: () => {
        insertCalls++;
        return { values: () => ({ returning: async () => [{ id: "should-not-happen" }] }) };
      },
      update: (table: unknown) => {
        if (table === courseMemberships) {
          return { set: () => ({ where: async () => undefined }) };
        }
        return {
          set: (v: Record<string, unknown>) => {
            updatedValues = v;
            return { where: async () => undefined };
          },
        };
      },
    } as unknown as Db;

    const result = await new UserIdentityService(cipher, db).createOrClaimUser(WORKOS_USER);

    expect(result).toEqual({ userId: "existing-user-1", isNew: false, sessionEpoch: 3 });
    expect(insertCalls).toBe(0);
    expect(updatedValues?.lastLoginAt).toBeInstanceOf(Date);
    expect(updatedValues?.isActive).toBe(true);
    // Email on WorkOS's side is unchanged, and netidBlindIndex is already
    // set -- no re-encryption needed for either field.
    expect(updatedValues?.email).toBeUndefined();
    expect(updatedValues?.netid).toBeUndefined();
  });

  it("reactivates a previously-deactivated user on a successful login (#95 self-healing)", async () => {
    const cipher = new IdentityCipher(keys);
    const encryptedEmail = await cipher.encryptString("cdcore@uw.edu");
    let updatedValues: Record<string, unknown> | undefined;
    let membershipRestore: Record<string, unknown> | undefined;
    const db = {
      query: {
        users: {
          findFirst: queuedFindFirst({
            id: "existing-user-1",
            isPending: false,
            isActive: false,
            sessionEpoch: 4,
            email: encryptedEmail,
            netidBlindIndex: new Uint8Array(32),
          }),
        },
      },
      update: (table: unknown) => {
        if (table === courseMemberships) {
          return {
            set: (v: Record<string, unknown>) => {
              membershipRestore = v;
              return { where: async () => undefined };
            },
          };
        }
        return {
          set: (v: Record<string, unknown>) => {
            updatedValues = v;
            return { where: async () => undefined };
          },
        };
      },
    } as unknown as Db;

    const result = await new UserIdentityService(cipher, db).createOrClaimUser(WORKOS_USER);

    // A completed WorkOS OAuth round trip is itself proof of current
    // authorization -- login clears isActive back to true, but must NOT
    // touch sessionEpoch (only the deactivation webhook does that), or an
    // existing valid session on another device would be invalidated by an
    // unrelated login.
    expect(updatedValues?.isActive).toBe(true);
    expect(result.sessionEpoch).toBe(4);
    // #142: reactivation also restores memberships this deactivation
    // dropped -- the mock can't express the droppedReason WHERE predicate,
    // but proves the restore write itself clears both columns.
    expect(membershipRestore).toEqual({ droppedAt: null, droppedReason: null });
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
            sessionEpoch: 0,
            email: staleEncryptedEmail,
            netidBlindIndex: new Uint8Array(32),
          }),
        },
      },
      update: (table: unknown) => {
        if (table === courseMemberships) {
          return { set: () => ({ where: async () => undefined }) };
        }
        return {
          set: (v: Record<string, unknown>) => {
            updatedValues = v;
            return { where: async () => undefined };
          },
        };
      },
    } as unknown as Db;

    const result = await new UserIdentityService(cipher, db).createOrClaimUser(WORKOS_USER);

    expect(result).toEqual({ userId: "existing-user-1", isNew: false, sessionEpoch: 0 });
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
          findFirst: queuedFindFirst(undefined, { id: "pending-user-1", isPending: true, sessionEpoch: 0 }),
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

    expect(result).toEqual({ userId: "pending-user-1", isNew: false, sessionEpoch: 0 });
    expect(updatedValues?.isPending).toBe(false);
    expect(updatedValues?.isActive).toBe(true);
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
              sessionEpoch: 0,
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

    expect(result).toEqual({ userId: "existing-user-1", isNew: false, sessionEpoch: 0 });
    // course-A only existed on the pending row -- moved onto existing-user-1.
    // Second entry is #142's unconditional reactivation-restore write (see
    // the mock's courseMemberships branch above), not another merge.
    expect(membershipUpdates).toEqual([
      { userId: "existing-user-1" },
      { droppedAt: null, droppedReason: null },
    ]);
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
              sessionEpoch: 0,
              email: staleEncryptedEmail,
              netidBlindIndex: new Uint8Array(32),
            },
            { id: "other-user-2", isPending: false },
          ),
        },
      },
      update: (table: unknown) => {
        if (table === courseMemberships) {
          return { set: () => ({ where: async () => undefined }) };
        }
        return {
          set: (v: Record<string, unknown>) => {
            finalUserUpdate = v;
            return { where: async () => undefined };
          },
        };
      },
    } as unknown as Db;

    const result = await new UserIdentityService(cipher, db).createOrClaimUser({
      id: "workos_1",
      email: "newname@uw.edu",
      firstName: "Cordero",
    });

    expect(result).toEqual({ userId: "existing-user-1", isNew: false, sessionEpoch: 0 });
    expect(finalUserUpdate?.email).toBeUndefined();
    expect(finalUserUpdate?.emailBlindIndex).toBeUndefined();
    expect(finalUserUpdate?.lastLoginAt).toBeInstanceOf(Date);
  });
});

describe("UserIdentityService.handleEmailUpdated (#142)", () => {
  it("re-encrypts the email and refreshes the blind index when it actually changed", async () => {
    const cipher = new IdentityCipher(keys);
    const staleEncryptedEmail = await cipher.encryptString("old-address@uw.edu");
    let updatedValues: Record<string, unknown> | undefined;
    const db = {
      query: {
        users: {
          findFirst: queuedFindFirst({
            id: "existing-user-1",
            email: staleEncryptedEmail,
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

    const result = await new UserIdentityService(cipher, db).handleEmailUpdated(
      "workos_1",
      "new-address@uw.edu",
    );

    expect(result).toEqual({ updated: true });
    expect(await cipher.decryptString(updatedValues?.email as never)).toBe("new-address@uw.edu");
    expect(updatedValues?.emailBlindIndex).toBeInstanceOf(Uint8Array);
  });

  it("is idempotent: no-ops when the email hasn't actually changed (duplicate delivery)", async () => {
    const cipher = new IdentityCipher(keys);
    const encryptedEmail = await cipher.encryptString("same@uw.edu");
    let updateCalls = 0;
    const db = {
      query: {
        users: { findFirst: queuedFindFirst({ id: "existing-user-1", email: encryptedEmail }) },
      },
      update: () => {
        updateCalls++;
        return { set: () => ({ where: async () => undefined }) };
      },
    } as unknown as Db;

    const result = await new UserIdentityService(cipher, db).handleEmailUpdated(
      "workos_1",
      "same@uw.edu",
    );

    expect(result).toEqual({ updated: false });
    expect(updateCalls).toBe(0);
  });

  it("no-ops for a workosUserId this app never provisioned", async () => {
    const cipher = new IdentityCipher(keys);
    let updateCalls = 0;
    const db = {
      query: { users: { findFirst: queuedFindFirst(undefined) } },
      update: () => {
        updateCalls++;
        return { set: () => ({ where: async () => undefined }) };
      },
    } as unknown as Db;

    const result = await new UserIdentityService(cipher, db).handleEmailUpdated(
      "workos_unknown",
      "whoever@uw.edu",
    );

    expect(result).toEqual({ updated: false });
    expect(updateCalls).toBe(0);
  });

  it("does not overwrite the email when the new address is already owned by another non-pending user", async () => {
    const cipher = new IdentityCipher(keys);
    const staleEncryptedEmail = await cipher.encryptString("old-address@uw.edu");
    let updateCalls = 0;
    const db = {
      query: {
        users: {
          findFirst: queuedFindFirst(
            { id: "existing-user-1", email: staleEncryptedEmail },
            { id: "other-user-2", isPending: false },
          ),
        },
      },
      update: () => {
        updateCalls++;
        return { set: () => ({ where: async () => undefined }) };
      },
    } as unknown as Db;

    const result = await new UserIdentityService(cipher, db).handleEmailUpdated(
      "workos_1",
      "already-taken@uw.edu",
    );

    expect(result).toEqual({ updated: false });
    expect(updateCalls).toBe(0);
  });
});
