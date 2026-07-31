import { eq } from "drizzle-orm";
import { users } from "../../db/schema";
import type { Db } from "../../db/client";
import { IdentityCipher } from "../crypto/identity-cipher";

export interface WorkOSProfile {
  id: string;
  email: string;
  firstName?: string | null;
}

export interface ProvisioningResult {
  userId: string;
  isNew: boolean;
}

/** Wires the previously-unused IdentityCipher into a real write path.
 *  Never stores plaintext PII; lookups always go through the blind index. */
export class UserIdentityService {
  constructor(
    private readonly cipher: IdentityCipher,
    private readonly db: Db,
  ) {}

  async createOrClaimUser(workosUser: WorkOSProfile): Promise<ProvisioningResult> {
    const normalizedEmail = IdentityCipher.normalizeEmail(workosUser.email);
    const emailBlindIndex = await this.cipher.computeBlindIndex(normalizedEmail);

    const existing = await this.db.query.users.findFirst({
      where: eq(users.emailBlindIndex, emailBlindIndex),
    });

    if (existing && !existing.isPending) {
      await this.db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, existing.id));
      return { userId: existing.id, isNew: false };
    }

    const encryptedEmail = await this.cipher.encryptString(normalizedEmail);
    const encryptedDisplayName = workosUser.firstName
      ? await this.cipher.encryptString(workosUser.firstName)
      : null;

    if (existing && existing.isPending) {
      await this.db
        .update(users)
        .set({
          workosUserId: workosUser.id,
          email: encryptedEmail,
          emailBlindIndex,
          displayName: encryptedDisplayName,
          isPending: false,
          lastLoginAt: new Date(),
        })
        .where(eq(users.id, existing.id));
      return { userId: existing.id, isNew: false };
    }

    const [created] = await this.db
      .insert(users)
      .values({
        workosUserId: workosUser.id,
        email: encryptedEmail,
        emailBlindIndex,
        displayName: encryptedDisplayName,
        isPending: false,
        lastLoginAt: new Date(),
      })
      .returning({ id: users.id });

    return { userId: created.id, isNew: true };
  }

  async decryptUserForDisplay(
    row: typeof users.$inferSelect,
  ): Promise<{ id: string; email: string; displayName: string | null }> {
    return {
      id: row.id,
      email: await this.cipher.decryptString(row.email),
      displayName: row.displayName ? await this.cipher.decryptString(row.displayName) : null,
    };
  }
}
