import type { Context, Next } from "hono";
import { eq } from "drizzle-orm";
import { makeDb } from "../../db/client";
import { courseMemberships, courseRoleEnum } from "../../db/schema";
import type { SessionPayload } from "../../lib/session";
import type { AppEnv } from "../context";

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
 *  session -- that case is already a 401 for protected routes. */
export async function rolesMiddleware(c: Context<AppEnv>, next: Next) {
  const session = c.get("session");
  if (!session) {
    await next();
    return;
  }

  const db = makeDb(c.env.DATABASE_URL);
  const memberships = await db.query.courseMemberships.findMany({
    where: eq(courseMemberships.userId, session.userId),
  });

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
