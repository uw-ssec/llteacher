import { eq } from "drizzle-orm";
import { organizations, users } from "../../db/schema";
import type { Db } from "../../db/client";
import type { BlindIndex } from "../../db/types/encrypted";
import { logServerError } from "../../server/utils/errors";

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

  /** Authoritative-first lookup, mirroring UserIdentityService.createOrClaimUser:
   *  an existing user is looked up by their stable `workosUserId` first, and
   *  only falls back to the (possibly stale) email blind index if that
   *  misses. This matters because this check runs precisely when the
   *  current WorkOS email's domain is disallowed -- which includes the case
   *  where an already-provisioned user's email changed upstream to a
   *  now-disallowed domain. Looking up by email alone would incorrectly
   *  lock that user out even though they're already provisioned. */
  static async checkGrandfathering(
    workosUserId: string,
    emailBlindIndex: BlindIndex,
    db: Db,
  ): Promise<boolean> {
    const byWorkosId = await db.query.users.findFirst({
      where: eq(users.workosUserId, workosUserId),
    });
    if (byWorkosId && !byWorkosId.isPending) return true;

    const byEmail = await db.query.users.findFirst({
      where: eq(users.emailBlindIndex, emailBlindIndex),
    });
    return Boolean(byEmail && !byEmail.isPending);
  }

  /** Resolves the allowed-domains policy for the organization the WorkOS
   *  user authenticated into. Falls back to DEFAULT_ALLOWED_DOMAINS when no
   *  organizationId was present on the auth response, or no local
   *  `organizations` row matches it yet (single-tenant v0 dev path).
   *
   *  Also falls back to the default -- rather than throwing -- if the
   *  lookup itself errors (e.g. the `organizations.allowedDomains` column
   *  from a migration in this same batch hasn't been applied yet). Without
   *  this, a missing migration turns into a total login outage for every
   *  org-scoped user instead of everyone safely getting the single-tenant
   *  default. */
  static async resolveAllowedDomains(
    organizationId: string | undefined,
    db: Db,
  ): Promise<string[]> {
    if (organizationId) {
      try {
        const org = await db.query.organizations.findFirst({
          where: eq(organizations.workosOrganizationId, organizationId),
        });
        if (org?.allowedDomains && org.allowedDomains.length > 0) {
          return org.allowedDomains;
        }
      } catch (err) {
        logServerError("DomainAllowlistService.resolveAllowedDomains", err);
      }
    }
    return DomainAllowlistService.DEFAULT_ALLOWED_DOMAINS;
  }
}
