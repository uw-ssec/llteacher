import { Effect } from "effect";
import { loadIdentityCipherKeys } from "../../lib/secrets-loader";
import { IdentityCipher } from "../../lib/crypto/identity-cipher";
import { grantPlatformInstructor } from "../repositories/users";
import { listPlatformInstructors } from "../repositories/platformListings";
import { getDeploymentOrganization } from "../repositories/organizations";
import { unsafeOrgScope } from "../repositories/scope";
import { AUDIT_ACTIONS, AUDIT_TARGET_TYPES, auditBestEffort } from "../utils/audit";
import type { AuthContext } from "../middleware/roles";
import type { GrantPlatformInstructorBody, GrantPlatformInstructorResponse } from "../../shared/types";
import { BadRequest, Conflict, Forbidden } from "../effect/errors";
import { effectHandler } from "../effect/http";
import { query } from "../effect/services";
import type { PlatformInstructorListResponse } from "@llteacher/ui/api";

export const listPlatformInstructorsHandler = effectHandler((c) => Effect.gen(function* () {
  const authContext = c.get("authContext") as AuthContext | undefined;
  if (!authContext?.isSuperAdmin) {
    return yield* new Forbidden({ message: "Super admin access required" });
  }
  const cipher = new IdentityCipher(yield* Effect.promise(() => loadIdentityCipherKeys(c.env)));
  const instructors = yield* query("listPlatformInstructors", (db) => listPlatformInstructors(db, cipher));
  return c.json({ instructors } satisfies PlatformInstructorListResponse);
}));

/** #316: grants courseless, platform-wide "recognized as an instructor"
 *  status by email. Not course-scoped -- no courseId anywhere in this
 *  route -- because the whole point is onboarding someone before any
 *  course exists for them (course_memberships.courseId is NOT NULL, so
 *  that table cannot represent this).
 *
 *  Registered behind requireSuperAdmin() (index.ts); the re-check here is
 *  defensive, matching every other handler in this app. */
export const grantPlatformInstructorHandler = effectHandler((c) => Effect.gen(function* () {
  const authContext = c.get("authContext") as AuthContext | undefined;
  if (!authContext || !authContext.isSuperAdmin) {
    return yield* new Forbidden({ message: "Super admin access required" });
  }

  const body = yield* Effect.tryPromise({
    try: () => c.req.json<GrantPlatformInstructorBody>(),
    catch: () => new BadRequest({ message: "Request body must be valid JSON" }),
  });
  const email = body.email;
  if (typeof email !== "string" || email.trim() === "") {
    return yield* new BadRequest({ message: "email is required" });
  }

  // Resolve the audit scope before the durable grant. If institution setup is
  // incomplete (or this lookup fails), no access change has happened for the
  // client to retry without an audit trail.
  const organization = yield* query("getDeploymentOrganization", (db) => getDeploymentOrganization(db));
  if (!organization) {
    return yield* new Conflict({ message: "Create the institution first" });
  }

  // The cipher keys are process configuration, not request input: a missing
  // key is a deployment fault, answered as a logged 503 defect.
  const cipher = new IdentityCipher(yield* Effect.promise(() => loadIdentityCipherKeys(c.env)));
  const result = yield* query(
    "grantPlatformInstructor",
    (db) => grantPlatformInstructor(
      db,
      cipher,
      authContext.session.userId,
      email,
      c.env.BOOTSTRAP_ALLOWED_DOMAINS,
    ),
  );

  if (result.status === "invalid_email" || result.status === "disallowed_domain") {
    return yield* new BadRequest({ message: result.message });
  }

  if (result.grantCreated) {
    yield* query("auditBestEffort", (db) =>
      auditBestEffort(db, [unsafeOrgScope(organization.id)], {
        actorUserId: authContext.session.userId,
        action: AUDIT_ACTIONS.PLATFORM_INSTRUCTOR_GRANTED,
        targetType: AUDIT_TARGET_TYPES.USER,
        targetId: result.userId,
      }),
    );
  }

  const responseBody: GrantPlatformInstructorResponse = {
    status: "granted",
    userId: result.userId,
    grantedAt: result.grantedAt,
  };
  return c.json(responseBody);
}));
