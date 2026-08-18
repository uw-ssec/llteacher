import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { IdentityCipher, type IdentityCipherKeys } from "../crypto/identity-cipher";
import { UserIdentityService } from "./UserIdentityService";
import { organizations, courses, users, courseMemberships } from "../../db/schema";
import { makeNodeDb } from "../../db/nodeClient";
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
    //
    // #172 re-audit (SEC-006): and that it restores the MEMBERSHIP without
    // the capability grants that sat on it. Asserted as an exact object, so
    // quietly carrying a grant back through a restore fails here. Re-granting
    // the answer key is an instructor's deliberate act; it must never be a
    // side effect of the grantee logging back in.
    expect(membershipRestore).toEqual({
      droppedAt: null,
      droppedReason: null,
      canViewSolutions: false,
      canViewDrafts: false,
    });
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
      // #207: the merge clears the grants rather than carrying them onto the
      // absorbing account. This is the write #210 makes reachable -- it
      // creates pending users holding `ta` memberships, so a grant on a
      // pending row is no longer hypothetical.
      { userId: "existing-user-1", canViewSolutions: false, canViewDrafts: false },
      // #172 re-audit (SEC-006): the restore brings the membership back
      // without the capability grants that were on it when it was dropped.
      { droppedAt: null, droppedReason: null, canViewSolutions: false, canViewDrafts: false },
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

  it("does NOT backfill a NetID derived from a denied email claim (#146)", async () => {
    // Regression for #146: the test above masks this bug because its
    // `existing` row already has a netidBlindIndex set, so the
    // `!existing.netidBlindIndex` guard is already false regardless of
    // whether the email claim succeeds. This fixture leaves netidBlindIndex
    // null/missing -- the only shape that actually exercises the bug (a
    // NetID derived from newname@uw.edu getting written even though the
    // email claim for newname@uw.edu was denied).
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
              netidBlindIndex: null,
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
    expect(finalUserUpdate?.netid).toBeUndefined();
    expect(finalUserUpdate?.netidBlindIndex).toBeUndefined();
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

const DATABASE_URL = process.env.DATABASE_URL;

// #152: the two mock-only gaps a live-DB mutation-testing pass found.
// Neither is a bug in shipped code -- deactivation selectivity and epoch
// revocation are already pinned by real-DB tests elsewhere (users.test.ts)
// -- these are the two paths that were only ever exercised against mocks
// whose `where` clauses are no-ops, so a regression in the real WHERE
// predicates would pass the whole suite undetected.
describe.skipIf(!DATABASE_URL)("UserIdentityService selective reactivation (#142, #152, real DB)", () => {
  let db: Db;
  let cipher: IdentityCipher;
  let orgId: string;
  let courseAId: string;
  let courseBId: string;
  let userId: string;
  const workosUserId = `workos-${crypto.randomUUID()}`;
  const email = "reactivation-test@uw.edu";

  beforeAll(async () => {
    db = makeNodeDb(DATABASE_URL!);
    cipher = new IdentityCipher(keys);

    const [org] = await db
      .insert(organizations)
      .values({ slug: `reactivate-${crypto.randomUUID()}`, name: "Reactivate Test Org", workosOrganizationId: `w-${crypto.randomUUID()}` })
      .returning({ id: organizations.id });
    orgId = org.id;
    const [courseA] = await db
      .insert(courses)
      .values({ organizationId: orgId, code: "A", term: "T", title: "T" })
      .returning({ id: courses.id });
    courseAId = courseA.id;
    const [courseB] = await db
      .insert(courses)
      .values({ organizationId: orgId, code: "B", term: "T", title: "T" })
      .returning({ id: courses.id });
    courseBId = courseB.id;

    const encryptedEmail = await cipher.encryptString(email);
    const emailBlindIndex = await cipher.computeBlindIndex(email);
    const [user] = await db
      .insert(users)
      .values({
        workosUserId,
        email: encryptedEmail,
        emailBlindIndex,
        isActive: false,
        sessionEpoch: 3,
      })
      .returning({ id: users.id });
    userId = user.id;

    // Dropped by this account's own deprovisioning -- must be restored.
    await db.insert(courseMemberships).values({
      userId,
      courseId: courseAId,
      role: "student",
      droppedAt: new Date(),
      droppedReason: "user_deprovisioned",
    });
    // Dropped for an unrelated reason (e.g. a Canvas roster removal) --
    // must NOT be restored just because the same user later logs back in.
    await db.insert(courseMemberships).values({
      userId,
      courseId: courseBId,
      role: "student",
      droppedAt: new Date(),
      droppedReason: "roster_removal",
    });
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("restores only the membership dropped by this account's own deprovisioning, not the one dropped for an unrelated reason", async () => {
    const result = await new UserIdentityService(cipher, db).createOrClaimUser({
      id: workosUserId,
      email,
      firstName: null,
    });

    expect(result.userId).toBe(userId);
    expect(result.isNew).toBe(false);
    expect(result.sessionEpoch).toBe(3); // login never touches sessionEpoch

    const [membershipA] = await db
      .select()
      .from(courseMemberships)
      .where(eq(courseMemberships.courseId, courseAId));
    expect(membershipA.droppedAt).toBeNull();
    expect(membershipA.droppedReason).toBeNull();

    const [membershipB] = await db
      .select()
      .from(courseMemberships)
      .where(eq(courseMemberships.courseId, courseBId));
    expect(membershipB.droppedAt).not.toBeNull();
    expect(membershipB.droppedReason).toBe("roster_removal");

    const [reactivatedUser] = await db.select().from(users).where(eq(users.id, userId));
    expect(reactivatedUser.isActive).toBe(true);
  });
});

describe.skipIf(!DATABASE_URL)("UserIdentityService.handleEmailUpdated (#142, #152, real DB)", () => {
  let db: Db;
  let cipher: IdentityCipher;
  const userAWorkosId = `workos-${crypto.randomUUID()}`;
  const userBWorkosId = `workos-${crypto.randomUUID()}`;
  let userAId: string;
  let userBId: string;

  beforeAll(async () => {
    db = makeNodeDb(DATABASE_URL!);
    cipher = new IdentityCipher(keys);

    const emailA = "handleupdate-a@uw.edu";
    const encryptedA = await cipher.encryptString(emailA);
    const blindA = await cipher.computeBlindIndex(emailA);
    const [userA] = await db
      .insert(users)
      .values({ workosUserId: userAWorkosId, email: encryptedA, emailBlindIndex: blindA })
      .returning({ id: users.id });
    userAId = userA.id;

    const emailB = "handleupdate-b@uw.edu";
    const encryptedB = await cipher.encryptString(emailB);
    const blindB = await cipher.computeBlindIndex(emailB);
    const [userB] = await db
      .insert(users)
      .values({ workosUserId: userBWorkosId, email: encryptedB, emailBlindIndex: blindB })
      .returning({ id: users.id });
    userBId = userB.id;
  });

  afterAll(async () => {
    await db.delete(users).where(eq(users.id, userAId));
    await db.delete(users).where(eq(users.id, userBId));
  });

  it("is idempotent: no-ops against real Postgres when the email hasn't actually changed", async () => {
    const result = await new UserIdentityService(cipher, db).handleEmailUpdated(
      userAWorkosId,
      "handleupdate-a@uw.edu",
    );
    expect(result).toEqual({ updated: false });

    const [row] = await db.select().from(users).where(eq(users.id, userAId));
    expect(await cipher.decryptString(row.email)).toBe("handleupdate-a@uw.edu");
  });

  it("re-encrypts and refreshes the blind index against real Postgres when the email changed", async () => {
    const result = await new UserIdentityService(cipher, db).handleEmailUpdated(
      userAWorkosId,
      "handleupdate-a-new@uw.edu",
    );
    expect(result).toEqual({ updated: true });

    const [row] = await db.select().from(users).where(eq(users.id, userAId));
    expect(await cipher.decryptString(row.email)).toBe("handleupdate-a-new@uw.edu");
    // The blind index must actually match the new email -- not just any
    // non-null value -- since it's how login reconciliation finds this
    // row again next time.
    expect(row.emailBlindIndex).toEqual(await cipher.computeBlindIndex("handleupdate-a-new@uw.edu"));
  });

  it("does not overwrite the email when the new address collides with another non-pending user (unique-constraint interaction)", async () => {
    // userA attempts to change to userB's real, already-claimed email.
    const result = await new UserIdentityService(cipher, db).handleEmailUpdated(
      userAWorkosId,
      "handleupdate-b@uw.edu",
    );
    expect(result).toEqual({ updated: false });

    const [rowA] = await db.select().from(users).where(eq(users.id, userAId));
    // Still the previous test's value, not userB's email and not
    // colliding with the unique emailBlindIndex constraint.
    expect(await cipher.decryptString(rowA.email)).toBe("handleupdate-a-new@uw.edu");

    const [rowB] = await db.select().from(users).where(eq(users.id, userBId));
    expect(await cipher.decryptString(rowB.email)).toBe("handleupdate-b@uw.edu");
  });
});
