import type { Context } from "hono";
import type { ProvisionCourseBody, ProvisionCourseResponse } from "@llteacher/ui/api";
import { makeDb } from "../../db/client";
import { IdentityCipher } from "../../lib/crypto/identity-cipher";
import { loadIdentityCipherKeys } from "../../lib/secrets-loader";
import type { AppEnv } from "../context";
import type { AuthContext } from "../middleware/roles";
import { provisionInstructorCourse } from "../repositories/courseProvisioning";

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
  const result = await provisionInstructorCourse(
    makeDb(c.env.DATABASE_URL),
    new IdentityCipher(await loadIdentityCipherKeys(c.env)),
    auth.session.userId,
    input,
  );
  if (result.status === "organization_missing") return c.json({ error: "Create the institution first" }, 409);
  if (result.status === "duplicate_course") return c.json({ error: "That course code and term already exist" }, 409);
  if (result.status === "invalid_email") return c.json({ error: result.message }, 400);
  return c.json({ course: result.course, instructor: result.instructor } satisfies ProvisionCourseResponse, 201);
}
