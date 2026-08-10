import { type Context } from "hono";
import { UUID_RE } from "../utils/uuid";
import { makeDb } from "../../db/client";
import { listCourseTas, setTaCapabilities } from "../repositories/courseMemberships";
import { getOrgScopeForCourse } from "../repositories/organizations";
import { courseScopeFromAuthContext } from "../repositories/scope";
import { AUDIT_ACTIONS, auditBestEffort } from "../utils/audit";
import { logServerError } from "../utils/errors";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import type { TaCapabilitiesBody, TaCapabilitiesResponse, CourseTaListResponse } from "../../shared/types";

/** #172: granting capabilities is authoring-tier authority, not grading --
 *  a TA must never be able to widen their own access, nor another TA's. So
 *  both handlers here use requireInstructorOf, unlike the grading reads
 *  which moved to requireGraderOf. */
export async function listCourseTasHandler(c: Context<AppEnv>) {
  const courseId = c.req.param("courseId");
  const authContext = c.get("authContext") as AuthContext | undefined;

  // Defensive re-check mirroring every other instructor-gated handler, so a
  // direct call (as the unit tests make) fails closed rather than throwing
  // past this point into the generic 503.
  if (!authContext || !courseId || !authContext.isInstructorOf(courseId)) {
    return c.json({ error: "Instructor access denied" }, 403);
  }
  const scope = courseScopeFromAuthContext(authContext, courseId);
  if (!scope) return c.json({ error: "Course access denied" }, 403);

  const db = makeDb(c.env.DATABASE_URL);
  const tas = await listCourseTas(db, scope);
  const body: CourseTaListResponse = { tas };
  return c.json(body);
}

export async function updateTaCapabilitiesHandler(c: Context<AppEnv>) {
  const courseId = c.req.param("courseId");
  const membershipId = c.req.param("membershipId");
  const authContext = c.get("authContext") as AuthContext | undefined;

  if (!authContext || !courseId || !authContext.isInstructorOf(courseId)) {
    return c.json({ error: "Instructor access denied" }, 403);
  }

  // #172 audit (SEC-003): a non-UUID path param would otherwise reach a
  // uuid-typed column comparison, raise a Postgres syntax error, and surface
  // as a 503 "try again later" for a permanently malformed client request.
  // Same 404 the not-found path returns, so the response stays uniform and
  // still leaks nothing about which memberships exist.
  if (!membershipId || !UUID_RE.test(membershipId)) {
    return c.json({ error: "TA membership not found in this course" }, 404);
  }

  let body: TaCapabilitiesBody;
  try {
    body = await c.req.json<TaCapabilitiesBody>();
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }

  // Both optional so an instructor can flip one capability without
  // restating the other, but anything present must be a real boolean --
  // an uncontrolled checkbox sending "" or "on" would otherwise be
  // coerced into a grant (the same class of bug #154's review found with
  // llmConfigId's empty-string default).
  if (body.canViewSolutions !== undefined && typeof body.canViewSolutions !== "boolean") {
    return c.json({ error: "canViewSolutions must be a boolean" }, 400);
  }
  if (body.canViewDrafts !== undefined && typeof body.canViewDrafts !== "boolean") {
    return c.json({ error: "canViewDrafts must be a boolean" }, 400);
  }
  if (body.canViewSolutions === undefined && body.canViewDrafts === undefined) {
    return c.json({ error: "At least one of canViewSolutions or canViewDrafts is required" }, 400);
  }

  const scope = courseScopeFromAuthContext(authContext, courseId);
  if (!scope) return c.json({ error: "Course access denied" }, 403);

  const db = makeDb(c.env.DATABASE_URL);
  const updated = await setTaCapabilities(db, scope, membershipId, {
    canViewSolutions: body.canViewSolutions,
    canViewDrafts: body.canViewDrafts,
  });
  // Null covers "no such membership", "belongs to another course", "not a
  // TA", and "already dropped" -- all indistinguishable to the caller by
  // design, so a probing instructor learns nothing about other courses.
  if (!updated) return c.json({ error: "TA membership not found in this course" }, 404);

  // Best-effort (#147): an audit-write failure must not fail a capability
  // change that already succeeded -- mirrors publishHomeworkHandler.
  //
  // #172 audit (SEC-002): scoped to the COURSE's org, not every org the
  // acting instructor belongs to. auditBestEffort fans out one row per
  // scope, which is right for personal actions (login, profile update) that
  // genuinely concern several orgs -- but a capability grant concerns
  // exactly one. Fanning out wrote another user's identity, a courseId and
  // their resulting access level into the audit log of unrelated tenants.
  try {
    const courseOrgScope = await getOrgScopeForCourse(db, courseId);
    await auditBestEffort(db, courseOrgScope ? [courseOrgScope] : [], {
      actorUserId: authContext.session.userId,
      action: AUDIT_ACTIONS.TA_CAPABILITIES_UPDATED,
      targetType: "user",
      targetId: updated.userId,
      requestMetadata: {
        courseId,
        membershipId: updated.membershipId,
        canViewSolutions: updated.canViewSolutions,
        canViewDrafts: updated.canViewDrafts,
      },
    });
  } catch (err) {
    logServerError("updateTaCapabilitiesHandler", err);
  }

  const responseBody: TaCapabilitiesResponse = updated;
  return c.json(responseBody);
}
