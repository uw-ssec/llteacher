import { eq } from "drizzle-orm";
import { users } from "../../db/schema";
import type { Db } from "../../db/client";
import { IdentityCipher } from "../crypto/identity-cipher";
import type { BlindIndex } from "../../db/types/encrypted";

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
 *  Never stores plaintext PII; lookups always go through the blind index.
 *
 *  Lookup order on every login is workosUserId first (authoritative --
 *  WorkOS is the identity provider of record), then emailBlindIndex
 *  (reconciles roster-provisioned "pending" rows and legacy rows created
 *  before a workosUserId was attached), then insert. Looking up by email
 *  alone would break repeat login after a user changes their email on the
 *  WorkOS side: the emailBlindIndex would no longer match, and inserting a
 *  "new" row would collide with the users_workos_user_uq constraint. */
export class UserIdentityService {
  constructor(
    private readonly cipher: IdentityCipher,
    private readonly db: Db,
  ) {}

  async createOrClaimUser(workosUser: WorkOSProfile): Promise<ProvisioningResult> {
    const normalizedEmail = IdentityCipher.normalizeEmail(workosUser.email);
    const emailBlindIndex = await this.cipher.computeBlindIndex(normalizedEmail);
    const netid = deriveNetid(normalizedEmail);
    const netidBlindIndex = netid ? await this.cipher.computeBlindIndex(netid) : null;

    const byWorkosId = await this.db.query.users.findFirst({
      where: eq(users.workosUserId, workosUser.id),
    });
    if (byWorkosId) {
      return this.reconcileExisting(
        byWorkosId,
        normalizedEmail,
        emailBlindIndex,
        netid,
        netidBlindIndex,
      );
    }

    const byEmail = await this.db.query.users.findFirst({
      where: eq(users.emailBlindIndex, emailBlindIndex),
    });

    if (byEmail && byEmail.isPending) {
      const encryptedEmail = await this.cipher.encryptString(normalizedEmail);
      const encryptedDisplayName = workosUser.firstName
        ? await this.cipher.encryptString(workosUser.firstName)
        : null;
      const encryptedNetid = netid ? await this.cipher.encryptString(netid) : null;
      await this.db
        .update(users)
        .set({
          workosUserId: workosUser.id,
          email: encryptedEmail,
          emailBlindIndex,
          displayName: encryptedDisplayName,
          netid: encryptedNetid,
          netidBlindIndex,
          isPending: false,
          lastLoginAt: new Date(),
        })
        .where(eq(users.id, byEmail.id));
      return { userId: byEmail.id, isNew: false };
    }

    if (byEmail && !byEmail.isPending) {
      // A non-pending row matched by email but not yet by workosUserId --
      // e.g. a row created before this WorkOS identity was attached to it.
      // Attach it rather than failing the unique workosUserId constraint.
      await this.db
        .update(users)
        .set({ workosUserId: workosUser.id, lastLoginAt: new Date() })
        .where(eq(users.id, byEmail.id));
      return { userId: byEmail.id, isNew: false };
    }

    const encryptedEmail = await this.cipher.encryptString(normalizedEmail);
    const encryptedDisplayName = workosUser.firstName
      ? await this.cipher.encryptString(workosUser.firstName)
      : null;
    const encryptedNetid = netid ? await this.cipher.encryptString(netid) : null;

    const [created] = await this.db
      .insert(users)
      .values({
        workosUserId: workosUser.id,
        email: encryptedEmail,
        emailBlindIndex,
        displayName: encryptedDisplayName,
        netid: encryptedNetid,
        netidBlindIndex,
        isPending: false,
        lastLoginAt: new Date(),
      })
      .returning({ id: users.id });

    return { userId: created.id, isNew: true };
  }

  private async reconcileExisting(
    existing: typeof users.$inferSelect,
    normalizedEmail: string,
    emailBlindIndex: BlindIndex,
    netid: string | null,
    netidBlindIndex: BlindIndex | null,
  ): Promise<ProvisioningResult> {
    const updates: Record<string, unknown> = { lastLoginAt: new Date() };

    const currentEmail = await this.cipher.decryptString(existing.email);
    if (currentEmail !== normalizedEmail) {
      updates.email = await this.cipher.encryptString(normalizedEmail);
      updates.emailBlindIndex = emailBlindIndex;
    }

    if (netid && !existing.netidBlindIndex) {
      updates.netid = await this.cipher.encryptString(netid);
      updates.netidBlindIndex = netidBlindIndex;
    }

    await this.db.update(users).set(updates).where(eq(users.id, existing.id));
    return { userId: existing.id, isNew: false };
  }
}

/** UW NetIDs are the local part of a uw.edu (or *.uw.edu) address --
 *  e.g. "cdcore@uw.edu" -> "cdcore". Non-UW domains (grandfathered users
 *  under issue #11) have no NetID to derive; `netid` stays null for them,
 *  matching issue #9's "when derivable" scope. */
function deriveNetid(normalizedEmail: string): string | null {
  const domain = normalizedEmail.split("@")[1];
  if (domain === "uw.edu" || domain?.endsWith(".uw.edu")) {
    const localPart = normalizedEmail.split("@")[0] ?? "";
    return IdentityCipher.normalizeNetid(localPart);
  }
  return null;
}
