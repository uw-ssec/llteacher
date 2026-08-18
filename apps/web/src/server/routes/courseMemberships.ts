import { type Context } from "hono";
import { UUID_RE } from "../utils/uuid";
import { loadIdentityCipherKeys } from "../../lib/secrets-loader";
import { IdentityCipher } from "../../lib/crypto/identity-cipher";
import { makeDb } from "../../db/client";
import {
  addTasByNetid,
  listCourseTas,
  removeCourseTa,
  setTaCapabilities,
} from "../repositories/courseMemberships";
import { getOrgScopeForCourse } from "../repositories/organizations";
import { courseScopeFromAuthContext } from "../repositories/scope";
import { AUDIT_ACTIONS, auditBestEffort } from "../utils/audit";
import { logServerError } from "../utils/errors";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import type {
  AddCourseTasBody,
  AddCourseTasResponse,
  CourseTaListResponse,
  RemoveCourseTaResponse,
  TaCapabilitiesBody,
  TaCapabilityGrantResponse,
} from "../../shared/types";

/** #210: the per-request cap on bulk NetID entry. Exported so the admin
 *  form states the same number it will be held to, rather than discovering
 *  it as a 400. */
export const MAX_TAS_PER_REQUEST = 100;

/** #172: granting capabilities is authoring-tier authority, not grading --
 *  a TA must never be able to widen their own access, nor another TA's. So
 *  both handlers here use requireInstructorOf, unlike the grading reads
 *  which moved to requireGraderOf. */
export async function listCourseTasHandler(c: Context<AppEnv>) {
  const courseId = c.req.param("courseId");
  const authContext = c.get("authContext") as AuthContext | undefined;

  // Defensive re-check, as updateHomeworkHandler / deleteHomeworkHandler /
  // publishHomeworkHandler do, so a direct call (as the unit tests make)
  // fails closed rather than throwing past this point into the generic 503.
  // (#200, MNT-025: this said "every other instructor-gated handler" while
  // createHomeworkHandler had no such re-check. It has one now -- but the
  // comment names the handlers rather than quantifying over them, so the
  // next one added without a re-check does not silently falsify it.)
  if (!authContext || !courseId || !authContext.isInstructorOf(courseId)) {
    return c.json({ error: "Instructor access denied" }, 403);
  }
  const scope = courseScopeFromAuthContext(authContext, courseId);
  if (!scope) return c.json({ error: "Course access denied" }, 403);

  const db = makeDb(c.env.DATABASE_URL);
  // Same construction as getHomeworkSubmissionsHandler, the existing
  // precedent for decrypting a roster at the route layer.
  const cipher = new IdentityCipher(await loadIdentityCipherKeys(c.env));
  const tas = await listCourseTas(db, scope, cipher);
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
    return c.json({ error: "That teaching assistant is no longer in this course." }, 404);
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
  if (!updated) return c.json({ error: "That teaching assistant is no longer in this course." }, 404);

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

  const responseBody: TaCapabilityGrantResponse = updated;
  return c.json(responseBody);
}

/** #210: adds TAs to a course by UW NetID.
 *
 *  requireInstructorOf, like the capability routes above and for the same
 *  reason: putting someone on the course as a TA is authoring-tier authority
 *  over who can read student work. A TA must not be able to recruit another
 *  TA, nor re-add themselves after removal.
 *
 *  Answers 200 with per-NetID results even when every entry failed. The
 *  request itself succeeded -- it is the individual NetIDs that did or did
 *  not resolve, and collapsing eight independent outcomes into one status
 *  code is exactly the unusable shape #210 rejects. A malformed *request*
 *  (bad JSON, no array, too many entries) is still a 400. */
export async function addCourseTasHandler(c: Context<AppEnv>) {
  const courseId = c.req.param("courseId");
  const authContext = c.get("authContext") as AuthContext | undefined;

  if (!authContext || !courseId || !authContext.isInstructorOf(courseId)) {
    return c.json({ error: "Instructor access denied" }, 403);
  }

  let body: AddCourseTasBody;
  try {
    body = await c.req.json<AddCourseTasBody>();
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }
  if (!Array.isArray(body.netids)) {
    return c.json({ error: "netids must be an array of NetIDs" }, 400);
  }
  if (body.netids.some((n) => typeof n !== "string")) {
    return c.json({ error: "Every entry in netids must be a string" }, 400);
  }
  if (body.netids.length === 0) {
    return c.json({ error: "Enter at least one NetID" }, 400);
  }
  // A bound, because each entry costs a blind-index HMAC plus up to three
  // round trips and the Worker has a wall-clock budget. 100 is far above a
  // real TA roster (single digits) and far below anything that could be used
  // to keep a Worker busy. Rejected outright rather than truncated -- adding
  // the first 100 of 500 pasted NetIDs and reporting success would be worse
  // than refusing.
  if (body.netids.length > MAX_TAS_PER_REQUEST) {
    return c.json(
      { error: `Add at most ${MAX_TAS_PER_REQUEST} NetIDs at a time.` },
      400,
    );
  }

  const scope = courseScopeFromAuthContext(authContext, courseId);
  if (!scope) return c.json({ error: "Course access denied" }, 403);

  const db = makeDb(c.env.DATABASE_URL);
  const cipher = new IdentityCipher(await loadIdentityCipherKeys(c.env));
  const results = await addTasByNetid(db, scope, cipher, body.netids);

  // Audited per NetID that actually changed something, scoped to the
  // COURSE's org -- the SEC-002 pattern, not a fan-out across every org the
  // acting instructor belongs to. `invalid_netid`, `already_ta` and
  // `role_conflict` wrote nothing, so they are not events.
  //
  // Best-effort (#147): an audit failure must not fail memberships that
  // already exist. Mirrors updateTaCapabilitiesHandler.
  try {
    const courseOrgScope = await getOrgScopeForCourse(db, courseId);
    const scopes = courseOrgScope ? [courseOrgScope] : [];
    await Promise.all(
      results
        .filter((r) => r.status === "added" || r.status === "restored")
        .map((r) =>
          auditBestEffort(db, scopes, {
            actorUserId: authContext.session.userId,
            action: AUDIT_ACTIONS.COURSE_TA_ADDED,
            targetType: "user",
            // The membership id, not the NetID: the audit log is org-scoped
            // storage, and a NetID is directly identifying. The membership
            // resolves to the person for anyone entitled to look.
            targetId: r.membershipId!,
            requestMetadata: { courseId, membershipId: r.membershipId, outcome: r.status },
          }),
        ),
    );
  } catch (err) {
    logServerError("addCourseTasHandler", err);
  }

  const responseBody: AddCourseTasResponse = { results };
  return c.json(responseBody);
}

/** #210: removes a TA from a course.
 *
 *  Soft-deletes (dropped_at + dropped_reason='roster_removal') and clears
 *  both capability flags -- see removeCourseTa. Never deletes the row:
 *  submissions, grades and audit events reference the membership. */
export async function removeCourseTaHandler(c: Context<AppEnv>) {
  const courseId = c.req.param("courseId");
  const membershipId = c.req.param("membershipId");
  const authContext = c.get("authContext") as AuthContext | undefined;

  if (!authContext || !courseId || !authContext.isInstructorOf(courseId)) {
    return c.json({ error: "Instructor access denied" }, 403);
  }
  // SEC-003's shape check: a non-UUID would otherwise reach a uuid-typed
  // column comparison and surface as a 503 for a permanently malformed
  // request. Same 404 as the not-found path, so the response stays uniform.
  if (!membershipId || !UUID_RE.test(membershipId)) {
    return c.json({ error: "That teaching assistant is no longer in this course." }, 404);
  }

  const scope = courseScopeFromAuthContext(authContext, courseId);
  if (!scope) return c.json({ error: "Course access denied" }, 403);

  const db = makeDb(c.env.DATABASE_URL);
  const removed = await removeCourseTa(db, scope, membershipId);
  if (!removed) {
    return c.json({ error: "That teaching assistant is no longer in this course." }, 404);
  }

  try {
    const courseOrgScope = await getOrgScopeForCourse(db, courseId);
    await auditBestEffort(db, courseOrgScope ? [courseOrgScope] : [], {
      actorUserId: authContext.session.userId,
      action: AUDIT_ACTIONS.COURSE_TA_REMOVED,
      targetType: "user",
      targetId: removed.userId,
      requestMetadata: { courseId, membershipId: removed.membershipId },
    });
  } catch (err) {
    logServerError("removeCourseTaHandler", err);
  }

  const responseBody: RemoveCourseTaResponse = { membershipId: removed.membershipId };
  return c.json(responseBody);
}
