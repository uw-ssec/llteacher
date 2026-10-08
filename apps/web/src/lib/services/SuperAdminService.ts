import { IdentityCipher } from "../crypto/identity-cipher";
import type { BlindIndex } from "../../db/types/encrypted";

/** Platform-wide super admins (issue #316): a deployment-configured,
 *  readable allowlist rather than a database row. The constant preserves
 *  UW compatibility when SUPER_ADMIN_EMAILS is absent; other institutions
 *  override it through ordinary deployment configuration.
 *
 *  A super admin bypasses every course-scoped guard everywhere in the app
 *  (see rolesMiddleware). Edit this list only with the same care as editing
 *  a deployment secret: adding an email here grants full access to every
 *  course, in every organization, immediately on that person's next
 *  request. */
export class SuperAdminService {
  static readonly SUPER_ADMIN_EMAILS: readonly string[] = ["ksdani@uw.edu", "cdcore@uw.edu"];

  static configuredEmails(configured?: string): string[] {
    if (!configured) return [...SuperAdminService.SUPER_ADMIN_EMAILS];
    const emails = [...new Set(configured.split(",").map(IdentityCipher.normalizeEmail).filter(Boolean))];
    if (emails.length === 0 || emails.some((email) => !/^\S+@\S+\.\S+$/.test(email))) {
      throw new Error("SUPER_ADMIN_EMAILS must contain comma-separated email addresses");
    }
    return emails;
  }

  /** Blind indexes for every configured super admin, under the caller's own
   *  IdentityCipher keys. Emails are never compared as plaintext -- `users`
   *  only stores AES-GCM ciphertext -- so this is the only way to check
   *  "is this user's email one of the configured admins" without decrypting
   *  the user's row. */
  static async blindIndexes(cipher: IdentityCipher, configured?: string): Promise<BlindIndex[]> {
    return Promise.all(
      SuperAdminService.configuredEmails(configured).map((email) =>
        cipher.computeBlindIndex(IdentityCipher.normalizeEmail(email)),
      ),
    );
  }

  /** Byte-equality against each configured admin's blind index. Blind
   *  indexes are already deterministic HMACs, not secrets an attacker could
   *  learn from timing this comparison (the secret is the blindIndexKey,
   *  never handled here), so a plain Buffer.compare is fine -- no need for
   *  crypto.timingSafeEqual. */
  static isSuperAdmin(userEmailBlindIndex: BlindIndex, superAdminBlindIndexes: readonly BlindIndex[]): boolean {
    return superAdminBlindIndexes.some(
      (adminIndex) => Buffer.compare(Buffer.from(adminIndex), Buffer.from(userEmailBlindIndex)) === 0,
    );
  }
}
