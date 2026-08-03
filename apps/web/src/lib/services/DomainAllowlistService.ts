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
    const atIndex = email.lastIndexOf("@");
    const atCount = email.split("@").length - 1;
    if (atCount !== 1 || atIndex === 0) {
      return { allowed: false, reason: "Invalid email format" };
    }
    const domain = email.slice(atIndex + 1).toLowerCase();
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
   *  user authenticated into. Falls back to DEFAULT_ALLOWED_DOMAINS only for
   *  the legitimate "no policy configured" cases: no organizationId was
   *  present on the auth response, or no local `organizations` row matches
   *  it yet (single-tenant v0 dev path).
   *
   *  An org row with `allowedDomains = []` is an explicit "block all
   *  provisioning for this org" and is returned as-is -- validateEmailDomain
   *  denies everything against an empty list. This is distinct from no row
   *  existing at all, which uses the default.
   *
   *  A lookup error (e.g. the `organizations.allowedDomains` column from a
   *  migration in this same batch hasn't been applied yet) is NOT treated
   *  as "no policy configured" -- it rethrows so the caller fails closed
   *  (callbackHandler's catch renders the 503 sign-in-unavailable page)
   *  rather than silently admitting the default domains for an org whose
   *  real policy may be narrower. */
  static async resolveAllowedDomains(
    organizationId: string | undefined,
    db: Db,
  ): Promise<string[]> {
    if (!organizationId) return DomainAllowlistService.DEFAULT_ALLOWED_DOMAINS;

    let org;
    try {
      org = await db.query.organizations.findFirst({
        where: eq(organizations.workosOrganizationId, organizationId),
      });
    } catch (err) {
      logServerError("DomainAllowlistService.resolveAllowedDomains", err);
      throw err;
    }

    if (!org) return DomainAllowlistService.DEFAULT_ALLOWED_DOMAINS;
    return org.allowedDomains;
  }
}
