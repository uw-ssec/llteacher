import type { Context } from "hono";
import type { AuthContext, CourseRole } from "../middleware/roles";
import type { AppEnv } from "../context";

type GuardedHandler = (c: Context<AppEnv>) => Response | Promise<Response>;

function getAuthContext(c: Context<AppEnv>): AuthContext | undefined {
  return c.get("authContext");
}

/** Guards decide *who* (role/membership); org-scoped repositories (M2)
 *  decide *which org's rows* -- the two compose, neither substitutes
 *  for the other. */
export function requireRole(allowedRoles: CourseRole[]) {
  return (handler: GuardedHandler) => async (c: Context<AppEnv>) => {
    const authContext = getAuthContext(c);
    if (!authContext || !allowedRoles.some((role) => authContext.hasRole(role))) {
      return c.json({ error: "Insufficient permissions" }, 403);
    }
    return handler(c);
  };
}

export function requireCourseMember(courseIdParam = "courseId") {
  return (handler: GuardedHandler) => async (c: Context<AppEnv>) => {
    const authContext = getAuthContext(c);
    const courseId = c.req.param(courseIdParam);
    if (!authContext || !courseId || !authContext.isMemberOf(courseId)) {
      return c.json({ error: "Course access denied" }, 403);
    }
    return handler(c);
  };
}

export function requireInstructorOf(courseIdParam = "courseId") {
  return (handler: GuardedHandler) => async (c: Context<AppEnv>) => {
    const authContext = getAuthContext(c);
    const courseId = c.req.param(courseIdParam);
    if (!authContext || !courseId || !authContext.isInstructorOf(courseId)) {
      return c.json({ error: "Instructor access denied" }, 403);
    }
    return handler(c);
  };
}
