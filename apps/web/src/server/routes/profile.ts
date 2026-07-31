import { Hono, type Context } from "hono";
import { makeDb } from "../../db/client";
import { loadIdentityCipherKeys } from "../../lib/secrets-loader";
import { IdentityCipher } from "../../lib/crypto/identity-cipher";
import { ProfileService } from "../../lib/services/ProfileService";
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

  const body = await c.req.json<{ displayName?: string }>();
  const displayName = body.displayName?.trim();
  if (!displayName) {
    return c.json({ error: "displayName is required" }, 400);
  }

  const cipher = new IdentityCipher(await loadIdentityCipherKeys(c.env));
  const db = makeDb(c.env.DATABASE_URL);
  const updated = await new ProfileService(cipher, db).updateDisplayName(
    session.userId,
    displayName,
  );
  return c.json(updated);
}

// Sub-app preserved for direct unit testing; production routing happens via
// app.get/patch("/api/profile", ...) in server/index.ts (see hello.ts).
export const profile = new Hono<AppEnv>();
profile.get("/", getProfileHandler);
profile.patch("/", patchProfileHandler);
