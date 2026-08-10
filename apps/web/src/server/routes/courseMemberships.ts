import { Hono, type Context } from "hono";
import { makeDb } from "../../db/client";
import { listCourseTas, setTaCapabilities } from "../repositories/courseMemberships";
import { getOrgScopesForUser } from "../repositories/users";
import { courseScopeFromAuthContext } from "../repositories/scope";
import { requireInstructorOf } from "../utils/guards";
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
  const updated = await setTaCapabilities(db, scope, membershipId!, {
    canViewSolutions: body.canViewSolutions,
    canViewDrafts: body.canViewDrafts,
  });
  // Null covers "no such membership", "belongs to another course", "not a
  // TA", and "already dropped" -- all indistinguishable to the caller by
  // design, so a probing instructor learns nothing about other courses.
  if (!updated) return c.json({ error: "TA membership not found in this course" }, 404);

  // Best-effort (#147): an audit-write failure must not fail a capability
  // change that already succeeded -- mirrors publishHomeworkHandler.
  try {
    const orgScopes = await getOrgScopesForUser(db, authContext.session.userId);
    await auditBestEffort(db, orgScopes, {
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

// Sub-app preserved for direct unit testing; production routing happens via
// app.get/app.patch(...) in server/index.ts (see homeworks.ts for the same
// pattern).
export const courseMembershipsRoutes = new Hono<AppEnv>();
courseMembershipsRoutes.get("/:courseId/tas", requireInstructorOf()(listCourseTasHandler));
courseMembershipsRoutes.patch(
  "/:courseId/tas/:membershipId/capabilities",
  requireInstructorOf()(updateTaCapabilitiesHandler),
);
