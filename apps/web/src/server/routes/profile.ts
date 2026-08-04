import { Hono, type Context } from "hono";
import { makeDb } from "../../db/client";
import { loadIdentityCipherKeys } from "../../lib/secrets-loader";
import { IdentityCipher } from "../../lib/crypto/identity-cipher";
import { ProfileService } from "../../lib/services/ProfileService";
import { getOrgScopesForUser } from "../repositories/users";
import { AUDIT_ACTIONS, auditBestEffort } from "../utils/audit";
import { logServerError } from "../utils/errors";
import type { AppEnv } from "../context";

export async function getProfileHandler(c: Context<AppEnv>) {
  const session = c.get("session");
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  const cipher = new IdentityCipher(await loadIdentityCipherKeys(c.env));
  const db = makeDb(c.env.DATABASE_URL);
  const profile = await new ProfileService(cipher, db).getProfileWithStats(session.userId);
  return c.json(profile);
}

export async function patchProfileHandler(c: Context<AppEnv>) {
  const session = c.get("session");
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  let body: { displayName?: unknown };
  try {
    body = await c.req.json<{ displayName?: unknown }>();
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }
  if (typeof body.displayName !== "string" || body.displayName.trim().length === 0) {
    return c.json({ error: "displayName is required" }, 400);
  }
  const displayName = body.displayName.trim();

  const cipher = new IdentityCipher(await loadIdentityCipherKeys(c.env));
  const db = makeDb(c.env.DATABASE_URL);
  const updated = await new ProfileService(cipher, db).updateDisplayName(
    session.userId,
    displayName,
  );

  // Best-effort (#147): an audit-write failure must not fail a profile
  // update that already succeeded.
  try {
    const orgScopes = await getOrgScopesForUser(db, session.userId);
    await auditBestEffort(db, orgScopes, {
      actorUserId: session.userId,
      action: AUDIT_ACTIONS.PROFILE_UPDATED,
      targetType: "user",
      targetId: session.userId,
    });
  } catch (err) {
    logServerError("patchProfileHandler", err);
  }

  return c.json(updated);
}

// Sub-app preserved for direct unit testing; production routing happens via
// app.get/patch("/api/profile", ...) in server/index.ts (see hello.ts).
export const profile = new Hono<AppEnv>();
profile.get("/", getProfileHandler);
profile.patch("/", patchProfileHandler);
