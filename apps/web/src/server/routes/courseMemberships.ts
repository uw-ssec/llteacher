import { type Context } from "hono";
import { Effect } from "effect";
import { UUID_RE } from "../utils/uuid";
import { loadIdentityCipherKeys } from "../../lib/secrets-loader";
import { IdentityCipher } from "../../lib/crypto/identity-cipher";
import { courseRoleEnum } from "../../db/schema";
import {
  addCourseMember,
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
  AddCourseMemberBody,
  AddCourseMemberResponse,
  AddCourseTasBody,
  AddCourseTasResponse,
  CourseTaListResponse,
  RemoveCourseTaResponse,
  TaCapabilitiesBody,
  TaCapabilityGrantResponse,
} from "../../shared/types";
import { BadRequest, Forbidden, NotFound } from "../effect/errors";
import { effectHandler } from "../effect/http";
import { query } from "../effect/services";

/** #210: the per-request cap on bulk NetID entry. Exported so the admin
 *  form states the same number it will be held to, rather than discovering
 *  it as a 400. */
export const MAX_TAS_PER_REQUEST = 100;

/** The cipher keys are process configuration, not request input: a missing
 *  key is a deployment fault, answered as a logged 503 defect. */
const identityCipher = (c: Context<AppEnv>) =>
  Effect.promise(() => loadIdentityCipherKeys(c.env)).pipe(Effect.map((keys) => new IdentityCipher(keys)));

const jsonBody = <T>(c: Context<AppEnv>) =>
  Effect.tryPromise({
    try: () => c.req.json<T>(),
    catch: () => new BadRequest({ message: "Request body must be valid JSON" }),
  });

const instructorDenied = () => new Forbidden({ message: "Instructor access denied" });
const courseDenied = () => new Forbidden({ message: "Course access denied" });
const taGone = () => new NotFound({ message: "That teaching assistant is no longer in this course." });

/** One audit write set against the course's own org (SEC-002). Best-effort
 *  (#147): a failure -- resolving the org or writing a row -- is logged and
 *  never fails a change that already happened. */
function courseAudit(
  where: string,
  courseId: string,
  inputs: readonly Parameters<typeof auditBestEffort>[2][],
) {
  return Effect.gen(function* () {
    const courseOrgScope = yield* query("getOrgScopeForCourse", (db) => getOrgScopeForCourse(db, courseId));
    const scopes = courseOrgScope ? [courseOrgScope] : [];
    yield* query("auditBestEffort", (db) => Promise.all(inputs.map((input) => auditBestEffort(db, scopes, input))));
  }).pipe(Effect.catchTag("DatabaseError", (err) => Effect.sync(() => logServerError(where, err.cause))));
}

/** #172: granting capabilities is authoring-tier authority, not grading --
 *  a TA must never be able to widen their own access, nor another TA's. So
 *  both handlers here use requireInstructorOf, unlike the grading reads
 *  which moved to requireGraderOf. */
export const listCourseTasHandler = effectHandler((c) => Effect.gen(function* () {
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
    return yield* instructorDenied();
  }
  const scope = courseScopeFromAuthContext(authContext, courseId);
  if (!scope) return yield* courseDenied();

  // Same construction as getHomeworkSubmissionsHandler, the existing
  // precedent for decrypting a roster at the route layer.
  const cipher = yield* identityCipher(c);
  const tas = yield* query("listCourseTas", (db) => listCourseTas(db, scope, cipher));
  const body: CourseTaListResponse = { tas };
  return c.json(body);
}));

export const updateTaCapabilitiesHandler = effectHandler((c) => Effect.gen(function* () {
  const courseId = c.req.param("courseId");
  const membershipId = c.req.param("membershipId");
  const authContext = c.get("authContext") as AuthContext | undefined;

  if (!authContext || !courseId || !authContext.isInstructorOf(courseId)) {
    return yield* instructorDenied();
  }

  // #172 audit (SEC-003): a non-UUID path param would otherwise reach a
  // uuid-typed column comparison, raise a Postgres syntax error, and surface
  // as a 503 "try again later" for a permanently malformed client request.
  // Same 404 the not-found path returns, so the response stays uniform and
  // still leaks nothing about which memberships exist.
  if (!membershipId || !UUID_RE.test(membershipId)) {
    return yield* taGone();
  }

  const body = yield* jsonBody<TaCapabilitiesBody>(c);

  // Both optional so an instructor can flip one capability without
  // restating the other, but anything present must be a real boolean --
  // an uncontrolled checkbox sending "" or "on" would otherwise be
  // coerced into a grant (the same class of bug #154's review found with
  // llmConfigId's empty-string default).
  if (body.canViewSolutions !== undefined && typeof body.canViewSolutions !== "boolean") {
    return yield* new BadRequest({ message: "canViewSolutions must be a boolean" });
  }
  if (body.canViewDrafts !== undefined && typeof body.canViewDrafts !== "boolean") {
    return yield* new BadRequest({ message: "canViewDrafts must be a boolean" });
  }
  if (body.canViewSolutions === undefined && body.canViewDrafts === undefined) {
    return yield* new BadRequest({ message: "At least one of canViewSolutions or canViewDrafts is required" });
  }

  const scope = courseScopeFromAuthContext(authContext, courseId);
  if (!scope) return yield* courseDenied();

  // setTaCapabilities' own "at least one flag" throw is unreachable: the
  // body checks above already refused that request with a 400.
  const updated = yield* query("setTaCapabilities", (db) => setTaCapabilities(db, scope, membershipId, {
    canViewSolutions: body.canViewSolutions,
    canViewDrafts: body.canViewDrafts,
  }));
  // Null covers "no such membership", "belongs to another course", "not a
  // TA", and "already dropped" -- all indistinguishable to the caller by
  // design, so a probing instructor learns nothing about other courses.
  if (!updated) return yield* taGone();

  // Best-effort (#147): an audit-write failure must not fail a capability
  // change that already succeeded -- mirrors publishHomeworkHandler.
  //
  // #172 audit (SEC-002): scoped to the COURSE's org, not every org the
  // acting instructor belongs to. auditBestEffort fans out one row per
  // scope, which is right for personal actions (login, profile update) that
  // genuinely concern several orgs -- but a capability grant concerns
  // exactly one. Fanning out wrote another user's identity, a courseId and
  // their resulting access level into the audit log of unrelated tenants.
  yield* courseAudit("updateTaCapabilitiesHandler", courseId, [{
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
  }]);

  const responseBody: TaCapabilityGrantResponse = updated;
  return c.json(responseBody);
}));

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
export const addCourseTasHandler = effectHandler((c) => Effect.gen(function* () {
  const courseId = c.req.param("courseId");
  const authContext = c.get("authContext") as AuthContext | undefined;

  if (!authContext || !courseId || !authContext.isInstructorOf(courseId)) {
    return yield* instructorDenied();
  }

  const body = yield* jsonBody<AddCourseTasBody>(c);
  if (!Array.isArray(body.netids)) {
    return yield* new BadRequest({ message: "netids must be an array of NetIDs" });
  }
  if (body.netids.some((n) => typeof n !== "string")) {
    return yield* new BadRequest({ message: "Every entry in netids must be a string" });
  }
  if (body.netids.length === 0) {
    return yield* new BadRequest({ message: "Enter at least one NetID" });
  }
  // A bound, because each entry costs a blind-index HMAC plus up to three
  // round trips and the Worker has a wall-clock budget. 100 is far above a
  // real TA roster (single digits) and far below anything that could be used
  // to keep a Worker busy. Rejected outright rather than truncated -- adding
  // the first 100 of 500 pasted NetIDs and reporting success would be worse
  // than refusing.
  if (body.netids.length > MAX_TAS_PER_REQUEST) {
    return yield* new BadRequest({ message: `Add at most ${MAX_TAS_PER_REQUEST} NetIDs at a time.` });
  }

  const scope = courseScopeFromAuthContext(authContext, courseId);
  if (!scope) return yield* courseDenied();

  const cipher = yield* identityCipher(c);
  const results = yield* query("addTasByNetid", (db) => addTasByNetid(db, scope, cipher, body.netids));

  // Audited per NetID that actually changed something, scoped to the
  // COURSE's org -- the SEC-002 pattern, not a fan-out across every org the
  // acting instructor belongs to. `invalid_netid`, `already_ta` and
  // `role_conflict` wrote nothing, so they are not events.
  //
  // Best-effort (#147): an audit failure must not fail memberships that
  // already exist. Mirrors updateTaCapabilitiesHandler.
  yield* courseAudit(
    "addCourseTasHandler",
    courseId,
    results
      .filter((r) => r.status === "added" || r.status === "restored")
      .map((r) => ({
        actorUserId: authContext.session.userId,
        action: AUDIT_ACTIONS.COURSE_TA_ADDED,
        targetType: "user",
        // The membership id, not the NetID: the audit log is org-scoped
        // storage, and a NetID is directly identifying. The membership
        // resolves to the person for anyone entitled to look.
        targetId: r.membershipId!,
        requestMetadata: { courseId, membershipId: r.membershipId, outcome: r.status },
      })),
  );

  const responseBody: AddCourseTasResponse = { results };
  return c.json(responseBody);
}));

/** #316: adds a member to a course by email under an explicit role.
 *
 *  requireSuperAdmin, not requireInstructorOf -- this is the general form
 *  issue #316 itself flags as a privilege escalation (an `instructor` grant
 *  gives someone authoring access over an entire course), so it is reachable
 *  only by the platform's configured super admins, never by an instructor
 *  of the target course. The TA-only add above stays on requireInstructorOf
 *  and is unaffected.
 *
 *  Reuses the same provisioning pipeline as every other enrollment path
 *  (upsertCourseMember via the new addCourseMember adapter) -- domain check,
 *  pending-user create-or-claim, already-enrolled/role-conflict/restore
 *  handling, all inherited rather than reimplemented. */
export const addCourseMemberHandler = effectHandler((c) => Effect.gen(function* () {
  const courseId = c.req.param("courseId");
  const authContext = c.get("authContext") as AuthContext | undefined;

  // Defensive re-check, matching every other handler in this file.
  if (!authContext || !courseId || !authContext.isSuperAdmin) {
    return yield* new Forbidden({ message: "Super admin access required" });
  }

  const body = yield* jsonBody<AddCourseMemberBody>(c);
  if (typeof body.email !== "string" || body.email.trim() === "") {
    return yield* new BadRequest({ message: "email is required" });
  }
  if (
    typeof body.role !== "string" ||
    !(courseRoleEnum.enumValues as readonly string[]).includes(body.role)
  ) {
    return yield* new BadRequest({ message: `role must be one of: ${courseRoleEnum.enumValues.join(", ")}` });
  }

  // #316's own guard: isSuperAdmin makes isInstructorOf/isMemberOf true for
  // EVERY course, including one this super admin has never touched -- that
  // is the point (granting access before any real membership exists for
  // them). courseScopeFromAuthContext still verifies courseId is a real,
  // syntactically-scoped id via that same bypassed predicate.
  const scope = courseScopeFromAuthContext(authContext, courseId);
  if (!scope) return yield* courseDenied();

  const cipher = yield* identityCipher(c);
  const { email, role } = body;
  const result = yield* query("addCourseMember", (db) => addCourseMember(db, scope, cipher, { email, role }));

  if (result.status === "invalid_email" || result.status === "disallowed_domain") {
    return yield* new BadRequest({ message: result.message ?? "That email address is not eligible for this course." });
  }

  // Best-effort (#147): an audit-write failure must not fail a membership
  // grant that already succeeded.
  if (result.status === "added" || result.status === "restored") {
    yield* courseAudit("addCourseMemberHandler", courseId, [{
      actorUserId: authContext.session.userId,
      action: AUDIT_ACTIONS.COURSE_MEMBER_ADDED,
      targetType: "user",
      targetId: result.membershipId!,
      requestMetadata: { courseId, role: body.role, outcome: result.status },
    }]);
  }

  const responseBody: AddCourseMemberResponse = result;
  return c.json(responseBody);
}));

/** #210: removes a TA from a course.
 *
 *  Soft-deletes (dropped_at + dropped_reason='roster_removal') and clears
 *  both capability flags -- see removeCourseTa. Never deletes the row:
 *  submissions, grades and audit events reference the membership. */
export const removeCourseTaHandler = effectHandler((c) => Effect.gen(function* () {
  const courseId = c.req.param("courseId");
  const membershipId = c.req.param("membershipId");
  const authContext = c.get("authContext") as AuthContext | undefined;

  if (!authContext || !courseId || !authContext.isInstructorOf(courseId)) {
    return yield* instructorDenied();
  }
  // SEC-003's shape check: a non-UUID would otherwise reach a uuid-typed
  // column comparison and surface as a 503 for a permanently malformed
  // request. Same 404 as the not-found path, so the response stays uniform.
  if (!membershipId || !UUID_RE.test(membershipId)) {
    return yield* taGone();
  }

  const scope = courseScopeFromAuthContext(authContext, courseId);
  if (!scope) return yield* courseDenied();

  const removed = yield* query("removeCourseTa", (db) => removeCourseTa(db, scope, membershipId));
  if (!removed) {
    return yield* taGone();
  }

  yield* courseAudit("removeCourseTaHandler", courseId, [{
    actorUserId: authContext.session.userId,
    action: AUDIT_ACTIONS.COURSE_TA_REMOVED,
    targetType: "user",
    targetId: removed.userId,
    requestMetadata: { courseId, membershipId: removed.membershipId },
  }]);

  const responseBody: RemoveCourseTaResponse = { membershipId: removed.membershipId };
  return c.json(responseBody);
}));
