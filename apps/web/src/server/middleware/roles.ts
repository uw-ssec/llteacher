import type { Context, Next } from "hono";
import { makeDb } from "../../db/client";
import { courseMemberships, courseRoleEnum } from "../../db/schema";
import { listMembershipsForUser, getUserActivationState } from "../repositories/users";
import type { SessionPayload } from "../../lib/session";
import type { AppEnv } from "../context";
import { PUBLIC_API_PATHS } from "./auth";

export type CourseRole = (typeof courseRoleEnum.enumValues)[number];
type Membership = typeof courseMemberships.$inferSelect;

export interface AuthContext {
  session: SessionPayload;
  memberships: Membership[];
  hasRole(role: CourseRole): boolean;
  isMemberOf(courseId: string): boolean;
  isInstructorOf(courseId: string): boolean;
}

/** Loads course_memberships once per request (not per guard) and attaches
 *  role-check helpers to the context. No-ops when authMiddleware found no
 *  session -- that case is already a 401 for protected routes -- and on
 *  PUBLIC_API_PATHS, where roles are meaningless (most importantly logout,
 *  which must be able to clear the session cookie even if the database is
 *  down).
 *
 *  Also enforces session revocation (#95): the sealed cookie is
 *  cryptographically valid on its own, but that only proves it hasn't been
 *  tampered with -- it says nothing about whether the account has since
 *  been deprovisioned. Piggybacks the isActive/sessionEpoch check onto this
 *  same per-request DB round-trip (parallel with the membership query, not
 *  a second sequential one) rather than adding it to authMiddleware, which
 *  stays purely cookie-based. */
export async function rolesMiddleware(c: Context<AppEnv>, next: Next) {
  const session = c.get("session");
  if (!session || PUBLIC_API_PATHS.has(c.req.path)) {
    await next();
    return;
  }

  const db = makeDb(c.env.DATABASE_URL);
  const [memberships, activation] = await Promise.all([
    listMembershipsForUser(db, session.userId),
    getUserActivationState(db, session.userId),
  ]);

  // Deprovisioned (isActive=false), or this cookie predates the account's
  // current session_epoch (a WorkOS deprovisioning webhook bumped it since
  // this cookie was issued) -- either way the cookie is cryptographically
  // valid but no longer authorized. Same 401 shape as authMiddleware's "no
  // session" case; the caller can't tell a revoked session from no session
  // at all, which is the point.
  if (!activation || !activation.isActive || activation.sessionEpoch !== session.sessionEpoch) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const authContext: AuthContext = {
    session,
    memberships,
    hasRole: (role) => memberships.some((m) => m.role === role),
    isMemberOf: (courseId) => memberships.some((m) => m.courseId === courseId),
    isInstructorOf: (courseId) =>
      memberships.some(
        (m) => m.courseId === courseId && (m.role === "instructor" || m.role === "admin"),
      ),
  };

  c.set("authContext", authContext);
  await next();
}
