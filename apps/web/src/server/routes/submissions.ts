import { type Context } from "hono";
import { makeDb } from "../../db/client";
import { UUID_RE } from "../utils/uuid";
import { submitSection, getHomeworkSubmissionsMatrix, TeacherTestNotSubmittableError } from "../repositories/submissions";
import { isUnreleased } from "../repositories/homeworks";
import { getOrgScopesForUser } from "../repositories/users";
import { courseScopeFromAuthContext } from "../repositories/scope";
import { loadIdentityCipherKeys } from "../../lib/secrets-loader";
import { IdentityCipher } from "../../lib/crypto/identity-cipher";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import type { SubmissionResponse } from "../../shared/types";

export async function submitSectionHandler(c: Context<AppEnv>) {
  const conversationId = c.req.param("id");
  const authContext = c.get("authContext") as AuthContext | undefined;

  // requireRole(["student"]) already verified authContext exists and has the
  // student role when this handler is reached via the guarded production
  // route; guarded again here -- mirrors studentHomeworksHandler in
  // routes/studentHomeworks.ts -- so the handler fails closed with a 403
  // even if reached unguarded, rather than throwing past this point (e.g.
  // on the getOrgScopesForUser call below) into the generic 503 handler.
  if (!authContext || !authContext.hasRole("student")) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  const db = makeDb(c.env.DATABASE_URL);
  // A student's conversation belongs to exactly one org via its course;
  // getOrgScopesForUser (existing, repositories/users.ts) returns every org
  // scope reachable through the caller's own non-dropped memberships --
  // submitSection's own conversation-ownership check (Task 16) is what
  // actually narrows this to the right one, this is just picking an org to
  // scope the query by (a student only ever belongs to one org in the
  // current single-org-per-user model this repo assumes elsewhere).
  const orgScopes = await getOrgScopesForUser(db, authContext.session.userId);
  const orgScope = orgScopes[0];
  if (!orgScope) return c.json({ error: "No organization membership found" }, 403);

  try {
    const result = await submitSection(db, orgScope, conversationId!, authContext.session.userId);
    const body: SubmissionResponse = {
      id: result.id,
      conversationId: result.conversationId,
      submittedAt: result.submittedAt.toISOString(),
      isResubmission: result.isResubmission,
    };
    return c.json(body, result.isResubmission ? 200 : 201);
  } catch (err) {
    // #242: the caller owns this conversation -- it is their own test run --
    // so naming the real reason leaks nothing, and "not found or not
    // accessible" would be simply false.
    if (err instanceof TeacherTestNotSubmittableError) {
      return c.json({ error: err.message }, 409);
    }
    // submitSection (Task 16) throws two distinct messages -- "Conversation
    // not found or not accessible" vs "Conversation is not owned by
    // requester" -- deliberately mapped to the same uniform 403 here rather
    // than distinguished by message, so a non-owner can't use a 404-vs-403
    // split to learn a conversation exists.
    return c.json({ error: "Conversation not found or not accessible" }, 403);
  }
}

export async function getHomeworkSubmissionsHandler(c: Context<AppEnv>) {
  const courseId = c.req.param("courseId");
  const homeworkId = c.req.param("homeworkId");
  const authContext = c.get("authContext") as AuthContext | undefined;

  // Guarded again here even though production routing already wraps this
  // handler in requireGraderOf() -- mirrors submitSectionHandler's own
  // fail-closed re-check above, so a direct call to the handler (as the
  // unit tests below do, and as buildSubmissionsApp does without the guard
  // middleware) still 403s rather than throwing past this point.
  // #172: grading authority, not authoring -- a TA may read this dashboard.
  if (!authContext || !courseId || !authContext.isGraderOf(courseId)) {
    return c.json({ error: "Grader access denied" }, 403);
  }

  const scope = courseScopeFromAuthContext(authContext, courseId);
  if (!scope) return c.json({ error: "Course access denied" }, 403);

  const db = makeDb(c.env.DATABASE_URL);
  // Constructed exactly as profile.ts's getProfileHandler/patchProfileHandler
  // already do -- the one existing precedent for building a cipher from
  // c.env at the route layer.
  const cipher = new IdentityCipher(await loadIdentityCipherKeys(c.env));
  // #206 (#172 re-audit, SEC-020): shape-checked before the id reaches a
  // uuid-typed column comparison. Postgres raises `invalid input syntax for
  // type uuid` on a malformed value, app.onError maps any throw to a generic
  // 503, and a permanent client error therefore reported itself as a backend
  // outage -- pollutable by any authenticated member on attacker-chosen
  // input. SEC-003 fixed exactly this for membershipId and its shared helper
  // claimed to cover "every UUID path param"; three were left behind.
  //
  // Returns this route's OWN not-found body, not a shared one: a distinct
  // message here would distinguish "malformed" from "no such row" and hand
  // back an existence oracle.
  if (!homeworkId || !UUID_RE.test(homeworkId)) {
    return c.json({ error: "Homework not found" }, 404);
  }

  const matrix = await getHomeworkSubmissionsMatrix(db, scope, cipher, homeworkId);
  if (!matrix) return c.json({ error: "Homework not found" }, 404);
  // #172 audit (SEC-001): grading authority does not imply access to
  // unreleased content. A TA the instructor denied `can_view_drafts` must
  // not read a draft/scheduled/hidden homework's title, due date or section
  // titles here after the detail route already 404s them for it. Same 404
  // shape, so the two routes stay indistinguishable to a prober.
  if (!authContext.canViewDraftsIn(courseId) && isUnreleased(matrix.homeworkStatus)) {
    return c.json({ error: "Homework not found" }, 404);
  }
  return c.json(matrix);
}
