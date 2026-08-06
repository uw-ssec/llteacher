import { describe, it, expect, beforeAll } from "vitest";
import { IdentityCipher, type IdentityCipherKeys } from "../crypto/identity-cipher";
import { ProfileService } from "./ProfileService";
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

describe("ProfileService.getProfileWithStats", () => {
  it("returns decrypted email/displayName and instructor stats", async () => {
    const cipher = new IdentityCipher(keys);
    const encryptedEmail = await cipher.encryptString("cdcore@uw.edu");
    const encryptedName = await cipher.encryptString("Cordero");
    const db = {
      query: {
        users: {
          findFirst: async () => ({
            id: "u1",
            email: encryptedEmail,
            displayName: encryptedName,
          }),
        },
        courseMemberships: {
          findMany: async () => [
            {
              id: "m1",
              userId: "u1",
              courseId: "c1",
              role: "instructor",
              droppedAt: null,
              course: { id: "c1", title: "STATS 311" },
            },
          ],
        },
        homeworks: {
          findMany: async () => [{ id: "h1" }, { id: "h2" }],
        },
      },
    } as unknown as Db;

    const profile = await new ProfileService(cipher, db).getProfileWithStats("u1");

    expect(profile.email).toBe("cdcore@uw.edu");
    expect(profile.displayName).toBe("Cordero");
    expect(profile.role).toBe("instructor");
    expect(profile.courseCount).toBe(1);
    expect(profile.instructorStats).toEqual({ homeworksCreated: 2 });
    expect(profile.studentStats).toBeUndefined();
    expect(profile.courses).toEqual([{ id: "c1", title: "STATS 311" }]);
  });

  it("excludes a dropped instructor membership's course from `courses`", async () => {
    const cipher = new IdentityCipher(keys);
    const encryptedEmail = await cipher.encryptString("multi-course@uw.edu");
    const db = {
      query: {
        users: {
          findFirst: async () => ({ id: "u4", email: encryptedEmail, displayName: null }),
        },
        courseMemberships: {
          findMany: async () => [
            {
              id: "m1",
              userId: "u4",
              courseId: "c1",
              role: "instructor",
              droppedAt: null,
              course: { id: "c1", title: "STATS 311" },
            },
            {
              id: "m2",
              userId: "u4",
              courseId: "c2",
              role: "instructor",
              droppedAt: new Date("2026-01-01"),
              course: { id: "c2", title: "STATS 412" },
            },
          ],
        },
        homeworks: { findMany: async () => [] },
      },
    } as unknown as Db;

    const profile = await new ProfileService(cipher, db).getProfileWithStats("u4");
    expect(profile.courses).toEqual([{ id: "c1", title: "STATS 311" }]);
  });

  it("stubs student stats to zero (no submissions/conversations table yet)", async () => {
    const cipher = new IdentityCipher(keys);
    const encryptedEmail = await cipher.encryptString("student@uw.edu");
    const db = {
      query: {
        users: { findFirst: async () => ({ id: "u2", email: encryptedEmail, displayName: null }) },
        courseMemberships: {
          findMany: async () => [{ id: "m2", userId: "u2", courseId: "c1", role: "student" }],
        },
        homeworks: { findMany: async () => [] },
      },
    } as unknown as Db;

    const profile = await new ProfileService(cipher, db).getProfileWithStats("u2");
    expect(profile.studentStats).toEqual({ submissionsCount: 0, completedSections: 0 });
    expect(profile.instructorStats).toBeUndefined();
    expect(profile.courses).toBeUndefined();
  });

  it("picks the highest-privilege role deterministically, regardless of findMany row order", async () => {
    const cipher = new IdentityCipher(keys);
    const encryptedEmail = await cipher.encryptString("multi@uw.edu");

    const makeDb = (memberships: Array<{ id: string; role: string }>) =>
      ({
        query: {
          users: {
            findFirst: async () => ({ id: "u3", email: encryptedEmail, displayName: null }),
          },
          courseMemberships: {
            findMany: async () =>
              memberships.map((m) => ({
                ...m,
                userId: "u3",
                courseId: "c1",
                droppedAt: null,
                course: { id: "c1", title: "STATS 311" },
              })),
          },
          homeworks: { findMany: async () => [] },
        },
      }) as unknown as Db;

    const instructorFirst = makeDb([
      { id: "m1", role: "instructor" },
      { id: "m2", role: "student" },
    ]);
    const studentFirst = makeDb([
      { id: "m2", role: "student" },
      { id: "m1", role: "instructor" },
    ]);

    const profileA = await new ProfileService(cipher, instructorFirst).getProfileWithStats("u3");
    const profileB = await new ProfileService(cipher, studentFirst).getProfileWithStats("u3");

    expect(profileA.role).toBe("instructor");
    expect(profileB.role).toBe("instructor");
  });

  it("throws when the user does not exist", async () => {
    const cipher = new IdentityCipher(keys);
    const db = { query: { users: { findFirst: async () => undefined } } } as unknown as Db;
    await expect(new ProfileService(cipher, db).getProfileWithStats("missing")).rejects.toThrow(
      /not found/i,
    );
  });
});

describe("ProfileService.updateDisplayName", () => {
  it("re-encrypts and stores the new display name", async () => {
    const cipher = new IdentityCipher(keys);
    let stored: Record<string, unknown> | undefined;
    const db = {
      update: () => ({
        set: (v: Record<string, unknown>) => {
          stored = v;
          return { where: async () => undefined };
        },
      }),
    } as unknown as Db;

    const result = await new ProfileService(cipher, db).updateDisplayName("u1", "New Name");
    expect(result).toEqual({ displayName: "New Name" });
    const storedCiphertext = stored?.displayName as Uint8Array;
    expect(await cipher.decryptString(storedCiphertext as never)).toBe("New Name");
  });
});
