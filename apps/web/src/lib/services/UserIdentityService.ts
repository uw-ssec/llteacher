import { and, eq } from "drizzle-orm";
import { courseMemberships, users } from "../../db/schema";
import type { Db } from "../../db/client";
import { IdentityCipher } from "../crypto/identity-cipher";
import type { BlindIndex } from "../../db/types/encrypted";
import { logServerError } from "../../server/utils/errors";

export interface WorkOSProfile {
  id: string;
  email: string;
  firstName?: string | null;
}

export interface ProvisioningResult {
  userId: string;
  isNew: boolean;
  /** Current users.session_epoch, to stamp into the session cookie (#95).
   *  Login never changes this value itself -- only a WorkOS deprovisioning
   *  webhook bumps it -- it's just read back here so the freshly-issued
   *  cookie matches whatever the DB currently holds. */
  sessionEpoch: number;
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
          isActive: true,
          lastLoginAt: new Date(),
        })
        .where(eq(users.id, byEmail.id));
      return { userId: byEmail.id, isNew: false, sessionEpoch: byEmail.sessionEpoch };
    }

    if (byEmail && !byEmail.isPending) {
      // A non-pending row matched by email but not yet by workosUserId --
      // e.g. a row created before this WorkOS identity was attached to it.
      // Attach it rather than failing the unique workosUserId constraint.
      await this.db
        .update(users)
        .set({ workosUserId: workosUser.id, isActive: true, lastLoginAt: new Date() })
        .where(eq(users.id, byEmail.id));
      return { userId: byEmail.id, isNew: false, sessionEpoch: byEmail.sessionEpoch };
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
      .returning({ id: users.id, sessionEpoch: users.sessionEpoch });

    return { userId: created.id, isNew: true, sessionEpoch: created.sessionEpoch };
  }

  private async reconcileExisting(
    existing: typeof users.$inferSelect,
    normalizedEmail: string,
    emailBlindIndex: BlindIndex,
    netid: string | null,
    netidBlindIndex: BlindIndex | null,
  ): Promise<ProvisioningResult> {
    // isActive: true unconditionally, even if it was already true -- a
    // completed WorkOS OAuth round trip for this exact identity is itself
    // proof of current authorization (#95). This is what makes a WorkOS
    // deprovisioning webhook self-healing: if the same identity later logs
    // in again legitimately, access is restored without any app-side
    // intervention. sessionEpoch is deliberately NOT touched here -- only
    // the deactivation webhook bumps it -- so an existing valid session on
    // another device isn't invalidated by an unrelated login elsewhere.
    const updates: Record<string, unknown> = { isActive: true, lastLoginAt: new Date() };

    // emailAccepted gates the NetID backfill below (#146): netid/netidBlindIndex
    // are derived from this same normalizedEmail, so writing them when the
    // email claim was denied would cross-link this user to a NetID derived
    // from an address they don't actually own -- either cross-linking two
    // real identities under one NetID blind index, or colliding with the
    // other account's netidBlindIndex (unique index) and 503-ing every
    // subsequent login attempt.
    const currentEmail = await this.cipher.decryptString(existing.email);
    let emailAccepted = currentEmail === normalizedEmail;
    if (!emailAccepted) {
      const canClaim = await this.claimEmailBlindIndex(existing, emailBlindIndex);
      if (canClaim) {
        updates.email = await this.cipher.encryptString(normalizedEmail);
        updates.emailBlindIndex = emailBlindIndex;
        emailAccepted = true;
      }
      // else: another non-pending user already owns this email. Keep the
      // old email (and don't derive a NetID from it) on `existing` -- see
      // claimEmailBlindIndex for details.
    }

    if (emailAccepted && netid && !existing.netidBlindIndex) {
      updates.netid = await this.cipher.encryptString(netid);
      updates.netidBlindIndex = netidBlindIndex;
    }

    await this.db.update(users).set(updates).where(eq(users.id, existing.id));

    // Self-healing membership restore (#142): a completed WorkOS login for
    // this identity is proof of re-authorization, so restore only the
    // memberships *this account's own deprovisioning* dropped -- never a
    // membership dropped for an unrelated reason (e.g. a genuine Canvas
    // roster removal), which must stay dropped. The droppedReason tag
    // written by deactivateByWorkosUserId is what makes that distinction
    // possible; restoring on droppedAt alone would be indiscriminate.
    await this.db
      .update(courseMemberships)
      .set({ droppedAt: null, droppedReason: null })
      .where(
        and(
          eq(courseMemberships.userId, existing.id),
          eq(courseMemberships.droppedReason, "user_deprovisioned"),
        ),
      );

    return { userId: existing.id, isNew: false, sessionEpoch: existing.sessionEpoch };
  }

  /** Re-encrypts the stored email and refreshes its blind index in response
   *  to a WorkOS `user.updated` webhook (#142) -- the same write path a
   *  login's reconcileExisting uses, without requiring the user to actually
   *  log in again. Reuses claimEmailBlindIndex so a stale pending row
   *  already squatting on the new email is absorbed the same way a login
   *  would absorb it, rather than failing the update.
   *
   *  No-ops (returns updated: false) for an unknown workosUserId (the
   *  webhook fired before this user's first login, or for an account this
   *  app never provisioned), when the email hasn't actually changed
   *  (duplicate delivery -- idempotent by construction, no dedup table
   *  needed for this event type either), or when claimEmailBlindIndex
   *  can't free the blind index (logged there). Deliberately does not
   *  touch netid, matching reconcileExisting's convention of only ever
   *  filling a missing netid, never overwriting one on an email change. */
  async handleEmailUpdated(
    workosUserId: string,
    newEmail: string,
  ): Promise<{ updated: boolean }> {
    const existing = await this.db.query.users.findFirst({
      where: eq(users.workosUserId, workosUserId),
    });
    if (!existing) return { updated: false };

    const normalizedEmail = IdentityCipher.normalizeEmail(newEmail);
    const currentEmail = await this.cipher.decryptString(existing.email);
    if (currentEmail === normalizedEmail) return { updated: false };

    const emailBlindIndex = await this.cipher.computeBlindIndex(normalizedEmail);
    const canClaim = await this.claimEmailBlindIndex(existing, emailBlindIndex);
    if (!canClaim) return { updated: false };

    await this.db
      .update(users)
      .set({
        email: await this.cipher.encryptString(normalizedEmail),
        emailBlindIndex,
      })
      .where(eq(users.id, existing.id));
    return { updated: true };
  }

  /** The `users_email_blind_index_uq` unique index means `existing` cannot
   *  take over `emailBlindIndex` while another row already holds it -- e.g.
   *  a roster sync created a *pending* row for the user's new address before
   *  they renamed their WorkOS account to it. Returns whether `existing` is
   *  now free to claim the blind index.
   *
   *  Pending holder: absorb its course memberships onto `existing` one at a
   *  time (each move is its own statement, and the pending row is deleted
   *  last) so a crash mid-merge leaves memberships intact on one row or the
   *  other, never orphaned. neon-http has no interactive transactions, so
   *  this sequencing -- rather than a single atomic transaction -- is what
   *  keeps a partial failure recoverable.
   *
   *  Non-pending holder: a second real account already owns the email.
   *  Fail this part of the reconcile gracefully (log, keep the old email)
   *  rather than throwing the whole login into the 503 path. */
  private async claimEmailBlindIndex(
    existing: typeof users.$inferSelect,
    emailBlindIndex: BlindIndex,
  ): Promise<boolean> {
    const holder = await this.db.query.users.findFirst({
      where: eq(users.emailBlindIndex, emailBlindIndex),
    });
    if (!holder || holder.id === existing.id) return true;

    if (!holder.isPending) {
      logServerError(
        "UserIdentityService.reconcileExisting",
        new Error(
          `user ${existing.id} cannot claim email already owned by non-pending user ${holder.id}`,
        ),
      );
      return false;
    }

    const [pendingMemberships, existingMemberships] = await Promise.all([
      this.db.query.courseMemberships.findMany({
        where: eq(courseMemberships.userId, holder.id),
      }),
      this.db.query.courseMemberships.findMany({
        where: eq(courseMemberships.userId, existing.id),
      }),
    ]);
    const existingCourseIds = new Set(existingMemberships.map((m) => m.courseId));

    for (const membership of pendingMemberships) {
      if (existingCourseIds.has(membership.courseId)) {
        // existing is already enrolled in this course -- drop the
        // duplicate rather than violating course_memberships_user_course_uq.
        await this.db.delete(courseMemberships).where(eq(courseMemberships.id, membership.id));
      } else {
        await this.db
          .update(courseMemberships)
          .set({ userId: existing.id })
          .where(eq(courseMemberships.id, membership.id));
      }
    }

    await this.db.delete(users).where(eq(users.id, holder.id));
    return true;
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
