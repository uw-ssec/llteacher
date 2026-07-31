import { eq } from "drizzle-orm";
import { organizations, users } from "../../db/schema";
import type { Db } from "../../db/client";
import type { BlindIndex } from "../../db/types/encrypted";

export interface DomainCheckResult {
  allowed: boolean;
  reason?: string;
}

/** Parity port of Django's ALLOWED_EMAIL_DOMAINS check
 *  (apps/accounts/src/accounts/utils.py) plus grandfathering for
 *  existing users whose domain is no longer allowed. */
export class DomainAllowlistService {
  /** v0 single-tenant fallback: used when the WorkOS org has no matching
   *  `organizations` row (e.g. local dev with no org provisioned) or its
   *  organizationId wasn't present on the authentication response. */
  static readonly DEFAULT_ALLOWED_DOMAINS = ["uw.edu"];

  static validateEmailDomain(email: string, allowedDomains: string[]): DomainCheckResult {
    const domain = email.split("@")[1]?.toLowerCase();
    if (!domain) {
      return { allowed: false, reason: "Invalid email format" };
    }
    const isAllowed = allowedDomains.some((allowed) => {
      const normalized = allowed.toLowerCase();
      return domain === normalized || domain.endsWith(`.${normalized}`);
    });
    if (isAllowed) return { allowed: true };
    return {
      allowed: false,
      reason: `Domain "${domain}" is not allowed. Allowed domains: ${allowedDomains.join(", ")}`,
    };
  }

  static async checkGrandfathering(emailBlindIndex: BlindIndex, db: Db): Promise<boolean> {
    const existing = await db.query.users.findFirst({
      where: eq(users.emailBlindIndex, emailBlindIndex),
    });
    return Boolean(existing && !existing.isPending);
  }

  /** Resolves the allowed-domains policy for the organization the WorkOS
   *  user authenticated into. Falls back to DEFAULT_ALLOWED_DOMAINS when no
   *  organizationId was present on the auth response, or no local
   *  `organizations` row matches it yet (single-tenant v0 dev path). */
  static async resolveAllowedDomains(
    organizationId: string | undefined,
    db: Db,
  ): Promise<string[]> {
    if (organizationId) {
      const org = await db.query.organizations.findFirst({
        where: eq(organizations.workosOrganizationId, organizationId),
      });
      if (org?.allowedDomains && org.allowedDomains.length > 0) {
        return org.allowedDomains;
      }
    }
    return DomainAllowlistService.DEFAULT_ALLOWED_DOMAINS;
  }
}
