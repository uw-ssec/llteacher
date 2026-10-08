import { Hono } from "hono";
import { Effect } from "effect";
import { loadIdentityCipherKeys } from "../../lib/secrets-loader";
import { IdentityCipher } from "../../lib/crypto/identity-cipher";
import { ProfileService } from "../../lib/services/ProfileService";
import { getOrgScopesForUser } from "../repositories/users";
import { AUDIT_ACTIONS, auditBestEffort } from "../utils/audit";
import { logServerError } from "../utils/errors";
import type { AppEnv } from "../context";
import type { ProfileResponse } from "../../shared/types";
import { BadRequest, Unauthorized } from "../effect/errors";
import { effectHandler } from "../effect/http";
import { query } from "../effect/services";

/** A missing/invalid ENCRYPTION_KEY or BLIND_INDEX_KEY is a deployment fault,
 *  not a request outcome: Effect.promise makes it a defect (logged, 503), as
 *  app.onError answered it before. */
const loadCipher = (env: Env) =>
  Effect.promise(() => loadIdentityCipherKeys(env)).pipe(Effect.map((keys) => new IdentityCipher(keys)));

export const getProfileHandler = effectHandler((c) => Effect.gen(function* () {
  const session = c.get("session");
  if (!session) return yield* new Unauthorized();

  const cipher = yield* loadCipher(c.env);
  const profile = yield* query(
    "getProfileWithStats",
    (db) => new ProfileService(cipher, db).getProfileWithStats(session.userId),
  );

  // #316: read off AuthContext, not re-derived here -- ProfileService only
  // ever takes a userId and has no AuthContext access, deliberately (it's a
  // DB-only service). rolesMiddleware has already computed both booleans by
  // the time this handler runs.
  const authContext = c.get("authContext");
  const responseBody: ProfileResponse = {
    ...profile,
    isSuperAdmin: authContext?.isSuperAdmin ?? false,
    isPlatformInstructor: authContext?.isPlatformInstructor ?? false,
  };
  return c.json(responseBody);
}));

export const patchProfileHandler = effectHandler((c) => Effect.gen(function* () {
  const session = c.get("session");
  if (!session) return yield* new Unauthorized();

  const body = yield* Effect.tryPromise({
    try: () => c.req.json<{ displayName?: unknown }>(),
    catch: () => new BadRequest({ message: "Request body must be valid JSON" }),
  });
  if (typeof body.displayName !== "string" || body.displayName.trim().length === 0) {
    return yield* new BadRequest({ message: "displayName is required" });
  }
  const displayName = body.displayName.trim();

  const cipher = yield* loadCipher(c.env);
  const updated = yield* query(
    "updateDisplayName",
    (db) => new ProfileService(cipher, db).updateDisplayName(session.userId, displayName),
  );

  // Best-effort (#147): an audit-write failure must not fail a profile
  // update that already succeeded.
  yield* Effect.gen(function* () {
    const orgScopes = yield* query("getOrgScopesForUser", (db) => getOrgScopesForUser(db, session.userId));
    yield* query("auditBestEffort", (db) => auditBestEffort(db, orgScopes, {
      actorUserId: session.userId,
      action: AUDIT_ACTIONS.PROFILE_UPDATED,
      targetType: "user",
      targetId: session.userId,
    }));
  }).pipe(Effect.catch((err) => Effect.sync(() => logServerError("patchProfileHandler", err.cause))));

  return c.json(updated);
}));

// Sub-app preserved for direct unit testing; production routing happens via
// app.get/patch("/api/profile", ...) in server/index.ts (see hello.ts).
export const profile = new Hono<AppEnv>();
profile.get("/", getProfileHandler);
profile.patch("/", patchProfileHandler);
