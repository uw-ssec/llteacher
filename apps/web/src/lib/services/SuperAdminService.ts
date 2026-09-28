import { IdentityCipher } from "../crypto/identity-cipher";
import type { BlindIndex } from "../../db/types/encrypted";

/** Platform-wide super admins (issue #316): a hardcoded, readable allowlist
 *  rather than a database row, matching DomainAllowlistService's own
 *  DEFAULT_ALLOWED_DOMAINS pattern. This is deliberately the smallest thing
 *  that works -- issue #316 recommends a real org-level role table as the
 *  long-term design, which is a separate decision this does not make.
 *
 *  A super admin bypasses every course-scoped guard everywhere in the app
 *  (see rolesMiddleware). Edit this list only with the same care as editing
 *  a deployment secret: adding an email here grants full access to every
 *  course, in every organization, immediately on that person's next
 *  request. */
export class SuperAdminService {
  static readonly SUPER_ADMIN_EMAILS: readonly string[] = ["ksdani@uw.edu", "cdcore@uw.edu"];

  /** Blind indexes for every configured super admin, under the caller's own
   *  IdentityCipher keys. Emails are never compared as plaintext -- `users`
   *  only stores AES-GCM ciphertext -- so this is the only way to check
   *  "is this user's email one of the configured admins" without decrypting
   *  the user's row. */
  static async blindIndexes(cipher: IdentityCipher): Promise<BlindIndex[]> {
    return Promise.all(
      SuperAdminService.SUPER_ADMIN_EMAILS.map((email) =>
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
