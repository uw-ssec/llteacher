import type { Context } from "hono";
import type {
  AddCourseInstructorBody,
  AddCourseInstructorResponse,
  PlatformCourseListResponse,
  ProvisionCourseBody,
  ProvisionCourseResponse,
} from "@llteacher/ui/api";
import { makeDb } from "../../db/client";
import { IdentityCipher } from "../../lib/crypto/identity-cipher";
import { loadIdentityCipherKeys } from "../../lib/secrets-loader";
import type { AppEnv } from "../context";
import type { AuthContext } from "../middleware/roles";
import { addInstructorToCourse, provisionInstructorCourse } from "../repositories/courseProvisioning";
import { listPlatformCourses } from "../repositories/platformListings";
import { unsafeOrgScope } from "../repositories/scope";
import { AUDIT_ACTIONS, AUDIT_TARGET_TYPES, auditBestEffort } from "../utils/audit";

export async function listPlatformCoursesHandler(c: Context<AppEnv>) {
  const auth = c.get("authContext") as AuthContext | undefined;
  if (!auth?.isSuperAdmin) return c.json({ error: "Super admin access required" }, 403);
  const db = makeDb(c.env.DATABASE_URL);
  const cipher = new IdentityCipher(await loadIdentityCipherKeys(c.env));
  return c.json({ courses: await listPlatformCourses(db, cipher) } satisfies PlatformCourseListResponse);
}

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
  const scopes = [unsafeOrgScope(result.organizationId)];
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

export async function addCourseInstructorHandler(c: Context<AppEnv>) {
  const auth = c.get("authContext") as AuthContext | undefined;
  if (!auth?.isSuperAdmin) return c.json({ error: "Super admin access required" }, 403);
  const courseId = c.req.param("courseId");
  if (!courseId) return c.json({ error: "Course not found" }, 404);
  let raw: unknown;
  try { raw = await c.req.json(); } catch { return c.json({ error: "Request body must be valid JSON" }, 400); }
  if (!raw || typeof raw !== "object") return c.json({ error: "Invalid instructor" }, 400);
  const body = raw as Partial<AddCourseInstructorBody>;
  const instructorEmail = typeof body.instructorEmail === "string" ? body.instructorEmail.trim().toLowerCase() : "";
  if (!/^\S+@\S+\.\S+$/.test(instructorEmail)) return c.json({ error: "Instructor email is required" }, 400);

  const db = makeDb(c.env.DATABASE_URL);
  const result = await addInstructorToCourse(
    db,
    new IdentityCipher(await loadIdentityCipherKeys(c.env)),
    auth.session.userId,
    courseId,
    instructorEmail,
  );
  if (result.status === "course_missing") return c.json({ error: "Course not found" }, 404);
  if (result.status === "invalid_email") return c.json({ error: result.message }, 400);

  const scopes = [unsafeOrgScope(result.organizationId)];
  await Promise.all([
    ...(result.platformInstructorGrantCreated ? [auditBestEffort(db, scopes, {
      actorUserId: auth.session.userId,
      action: AUDIT_ACTIONS.PLATFORM_INSTRUCTOR_GRANTED,
      targetType: AUDIT_TARGET_TYPES.USER,
      targetId: result.instructor.userId,
    })] : []),
    ...(result.membershipAdded ? [auditBestEffort(db, scopes, {
      actorUserId: auth.session.userId,
      action: AUDIT_ACTIONS.COURSE_INSTRUCTOR_ADDED,
      targetType: AUDIT_TARGET_TYPES.MEMBERSHIP,
      targetId: result.membershipId,
      requestMetadata: { courseId, instructorUserId: result.instructor.userId },
    })] : []),
  ]);
  const payload = {
    instructor: result.instructor,
    membershipAdded: result.membershipAdded,
  } satisfies AddCourseInstructorResponse;
  return result.membershipAdded ? c.json(payload, 201) : c.json(payload, 200);
}
