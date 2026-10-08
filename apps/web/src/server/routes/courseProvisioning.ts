import type { Context } from "hono";
import type { ProvisionCourseBody, ProvisionCourseResponse } from "@llteacher/ui/api";
import { makeDb } from "../../db/client";
import { IdentityCipher } from "../../lib/crypto/identity-cipher";
import { loadIdentityCipherKeys } from "../../lib/secrets-loader";
import type { AppEnv } from "../context";
import type { AuthContext } from "../middleware/roles";
import { provisionInstructorCourse } from "../repositories/courseProvisioning";
import { getOrgScopeForCourse } from "../repositories/organizations";
import { AUDIT_ACTIONS, AUDIT_TARGET_TYPES, auditBestEffort } from "../utils/audit";

export async function provisionCourseHandler(c: Context<AppEnv>) {
  const auth = c.get("authContext") as AuthContext | undefined;
  if (!auth?.isSuperAdmin) return c.json({ error: "Super admin access required" }, 403);
  let raw: unknown;
  try { raw = await c.req.json(); } catch { return c.json({ error: "Request body must be valid JSON" }, 400); }
  if (!raw || typeof raw !== "object") return c.json({ error: "Invalid course" }, 400);
  const body = raw as Partial<ProvisionCourseBody>;
  const input = {
    instructorEmail: typeof body.instructorEmail === "string" ? body.instructorEmail.trim().toLowerCase() : "",
    title: typeof body.title === "string" ? body.title.trim() : "",
    code: typeof body.code === "string" ? body.code.trim() : "",
    term: typeof body.term === "string" ? body.term.trim() : "",
  };
  if (!/^\S+@\S+\.\S+$/.test(input.instructorEmail) || !input.title || !input.code || !input.term) {
    return c.json({ error: "Instructor email, title, code, and term are required" }, 400);
  }
  const db = makeDb(c.env.DATABASE_URL);
  const result = await provisionInstructorCourse(
    db,
    new IdentityCipher(await loadIdentityCipherKeys(c.env)),
    auth.session.userId,
    input,
  );
  if (result.status === "organization_missing") return c.json({ error: "Create the institution first" }, 409);
  if (result.status === "duplicate_course") return c.json({ error: "That course code and term already exist" }, 409);
  if (result.status === "invalid_email") return c.json({ error: result.message }, 400);
  const orgScope = await getOrgScopeForCourse(db, result.course.id);
  const scopes = orgScope ? [orgScope] : [];
  await Promise.all([
    auditBestEffort(db, scopes, {
      actorUserId: auth.session.userId,
      action: AUDIT_ACTIONS.COURSE_CREATED,
      targetType: AUDIT_TARGET_TYPES.COURSE,
      targetId: result.course.id,
      requestMetadata: { instructorUserId: result.instructor.userId },
    }),
    ...(result.platformInstructorGrantCreated ? [auditBestEffort(db, scopes, {
      actorUserId: auth.session.userId,
      action: AUDIT_ACTIONS.PLATFORM_INSTRUCTOR_GRANTED,
      targetType: AUDIT_TARGET_TYPES.USER,
      targetId: result.instructor.userId,
    })] : []),
    auditBestEffort(db, scopes, {
      actorUserId: auth.session.userId,
      action: AUDIT_ACTIONS.COURSE_INSTRUCTOR_ADDED,
      targetType: AUDIT_TARGET_TYPES.MEMBERSHIP,
      targetId: result.membershipId,
      requestMetadata: { courseId: result.course.id, instructorUserId: result.instructor.userId },
    }),
  ]);
  return c.json({ course: result.course, instructor: result.instructor } satisfies ProvisionCourseResponse, 201);
}
