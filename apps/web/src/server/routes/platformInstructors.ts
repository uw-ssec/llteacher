import type { Context } from "hono";
import { makeDb } from "../../db/client";
import { loadIdentityCipherKeys } from "../../lib/secrets-loader";
import { IdentityCipher } from "../../lib/crypto/identity-cipher";
import { grantPlatformInstructor } from "../repositories/users";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import type { GrantPlatformInstructorBody, GrantPlatformInstructorResponse } from "../../shared/types";

/** #316: grants courseless, platform-wide "recognized as an instructor"
 *  status by email. Not course-scoped -- no courseId anywhere in this
 *  route -- because the whole point is onboarding someone before any
 *  course exists for them (course_memberships.courseId is NOT NULL, so
 *  that table cannot represent this).
 *
 *  Registered behind requireSuperAdmin() (index.ts); the re-check here is
 *  defensive, matching every other handler in this app. */
export async function grantPlatformInstructorHandler(c: Context<AppEnv>) {
  const authContext = c.get("authContext") as AuthContext | undefined;
  if (!authContext || !authContext.isSuperAdmin) {
    return c.json({ error: "Super admin access required" }, 403);
  }

  let body: GrantPlatformInstructorBody;
  try {
    body = await c.req.json<GrantPlatformInstructorBody>();
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }
  if (typeof body.email !== "string" || body.email.trim() === "") {
    return c.json({ error: "email is required" }, 400);
  }

  const db = makeDb(c.env.DATABASE_URL);
  const cipher = new IdentityCipher(await loadIdentityCipherKeys(c.env));
  const result = await grantPlatformInstructor(db, cipher, authContext.session.userId, body.email);

  if (result.status === "invalid_email" || result.status === "disallowed_domain") {
    return c.json({ error: result.message }, 400);
  }

  const responseBody: GrantPlatformInstructorResponse = result;
  return c.json(responseBody);
}
