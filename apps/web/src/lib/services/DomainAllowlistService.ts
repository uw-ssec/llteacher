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
  /** Backward-compatible UW fallback: used when the WorkOS org has no matching
   *  `organizations` row (e.g. local dev with no org provisioned) or its
   *  organizationId wasn't present on the authentication response and the
   *  deployment did not configure BOOTSTRAP_ALLOWED_DOMAINS. */
  static readonly DEFAULT_ALLOWED_DOMAINS = ["uw.edu"];

  static bootstrapAllowedDomains(configured?: string): string[] {
    if (!configured) return [...DomainAllowlistService.DEFAULT_ALLOWED_DOMAINS];
    const domains = [...new Set(configured.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean))];
    if (domains.length === 0) throw new Error("BOOTSTRAP_ALLOWED_DOMAINS must contain at least one domain");
    return domains;
  }

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
   *  user authenticated into. A matching WorkOS organization is preferred;
   *  otherwise this single-institution deployment uses its singleton row.
   *  Bootstrap domains apply only before that row exists.
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
    bootstrapDomains?: string,
  ): Promise<string[]> {
    const fallback = DomainAllowlistService.bootstrapAllowedDomains(bootstrapDomains);
    let org: { allowedDomains: string[] } | undefined;
    try {
      if (organizationId) {
        org = await db.query.organizations.findFirst({
          where: eq(organizations.workosOrganizationId, organizationId),
          columns: { allowedDomains: true },
        });
      }
      org ??= await db.query.organizations.findFirst({
        where: eq(organizations.deploymentSingleton, true),
        columns: { allowedDomains: true },
      });
    } catch (err) {
      logServerError("DomainAllowlistService.resolveAllowedDomains", err);
      throw err;
    }

    if (!org) return fallback;
    return org.allowedDomains;
  }
}
