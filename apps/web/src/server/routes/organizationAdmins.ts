/* --------------------------------------------------------------------------
   #367: Org Admin provisioning.

   An Org Admin owns an organization's shared LLM configuration pool and its
   default (routes/llmConfigs.ts). Nobody is an Org Admin by migration: the
   role is never backfilled from course roles, because promoting every
   instructor would preserve exactly the widening it exists to remove. So the
   bootstrap path is a super admin (SuperAdminService's allowlist), who holds
   isOrgAdminOf everywhere; after that, an Org Admin may grant and revoke the
   role within their own organization.

   Org-keyed routes (/api/organizations/:organizationId/...), not
   course-keyed: the authority is about the organization, and resolving it
   through a course would reintroduce the "checked key differs from written
   key" shape #367 removes.
   -------------------------------------------------------------------------- */

import { Effect } from "effect";
import { UUID_RE } from "../utils/uuid";
import { loadIdentityCipherKeys } from "../../lib/secrets-loader";
import { IdentityCipher } from "../../lib/crypto/identity-cipher";
import { grantOrgAdmin, listOrgAdmins, revokeOrgAdmin } from "../repositories/users";
import { unsafeOrgScope } from "../repositories/scope";
import { AUDIT_ACTIONS, AUDIT_TARGET_TYPES, auditBestEffort } from "../utils/audit";
import { logServerError } from "../utils/errors";
import type { AuthContext } from "../middleware/roles";
import { BadRequest, Forbidden, NotFound } from "../effect/errors";
import { effectHandler } from "../effect/http";
import { query } from "../effect/services";

/** The organization this request names, if the caller administers it. A
 *  malformed id and "not your organization" answer the same 403, so the
 *  route is not an existence oracle for organization ids. */
function administeredOrganization(authContext: AuthContext | undefined, organizationId: string | undefined) {
  if (!authContext || !organizationId || !UUID_RE.test(organizationId)) return null;
  return authContext.isOrgAdminOf(organizationId) ? organizationId : null;
}

const denied = () => new Forbidden({ message: "Organization admin access required" });

export const listOrgAdminsHandler = effectHandler((c) => Effect.gen(function* () {
  const authContext = c.get("authContext") as AuthContext | undefined;
  const organizationId = administeredOrganization(authContext, c.req.param("organizationId"));
  if (!organizationId) return yield* denied();
  const cipher = new IdentityCipher(yield* Effect.promise(() => loadIdentityCipherKeys(c.env)));
  const admins = yield* query("listOrgAdmins", (db) => listOrgAdmins(db, cipher, organizationId));
  return c.json({ admins });
}));

export const grantOrgAdminHandler = effectHandler((c) => Effect.gen(function* () {
  const authContext = c.get("authContext") as AuthContext | undefined;
  const organizationId = administeredOrganization(authContext, c.req.param("organizationId"));
  if (!authContext || !organizationId) return yield* denied();

  const body = yield* Effect.tryPromise({
    try: () => c.req.json<{ email?: unknown }>(),
    catch: () => new BadRequest({ message: "Request body must be valid JSON" }),
  });
  if (typeof body.email !== "string" || body.email.trim() === "") {
    return yield* new BadRequest({ message: "email is required" });
  }
  const email = body.email;

  const cipher = new IdentityCipher(yield* Effect.promise(() => loadIdentityCipherKeys(c.env)));
  const result = yield* query(
    "grantOrgAdmin",
    (db) => grantOrgAdmin(db, cipher, authContext.session.userId, organizationId, email),
  );
  if (result.status === "organization_missing") {
    return yield* new NotFound({ message: result.message });
  }
  if (result.status !== "granted") return yield* new BadRequest({ message: result.message });

  yield* audit(authContext, organizationId, AUDIT_ACTIONS.ORG_ADMIN_GRANTED, result.userId);
  return c.json({ userId: result.userId, organizationId }, 201);
}));

export const revokeOrgAdminHandler = effectHandler((c) => Effect.gen(function* () {
  const authContext = c.get("authContext") as AuthContext | undefined;
  const organizationId = administeredOrganization(authContext, c.req.param("organizationId"));
  if (!authContext || !organizationId) return yield* denied();
  const userId = c.req.param("userId");
  if (!userId || !UUID_RE.test(userId)) return yield* new NotFound({ message: "That person is not an organization admin here." });

  const removed = yield* query("revokeOrgAdmin", (db) => revokeOrgAdmin(db, organizationId, userId));
  if (!removed) return yield* new NotFound({ message: "That person is not an organization admin here." });

  yield* audit(authContext, organizationId, AUDIT_ACTIONS.ORG_ADMIN_REVOKED, userId);
  return c.json({ userId, organizationId, revoked: true });
}));

/** Best-effort, like every other audit write: the grant already landed. */
function audit(authContext: AuthContext, organizationId: string, action: string, targetUserId: string) {
  return query("auditBestEffort", (db) =>
    auditBestEffort(db, [unsafeOrgScope(organizationId)], {
      actorUserId: authContext.session.userId,
      action,
      targetType: AUDIT_TARGET_TYPES.USER,
      targetId: targetUserId,
      requestMetadata: { organizationId },
    }),
  ).pipe(Effect.catchTag("DatabaseError", (err) => Effect.sync(() => logServerError("orgAdminAudit", err.cause))));
}
