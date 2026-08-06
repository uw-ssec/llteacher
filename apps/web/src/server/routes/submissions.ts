import { Hono, type Context } from "hono";
import { makeDb } from "../../db/client";
import { submitSection, getHomeworkSubmissionsMatrix } from "../repositories/submissions";
import { getOrgScopesForUser } from "../repositories/users";
import { requireRole } from "../utils/guards";
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
  } catch {
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
  // handler in requireInstructorOf() -- mirrors submitSectionHandler's own
  // fail-closed re-check above, so a direct call to the handler (as the
  // unit tests below do, and as buildSubmissionsApp does without the guard
  // middleware) still 403s rather than throwing past this point.
  if (!authContext || !courseId || !authContext.isInstructorOf(courseId)) {
    return c.json({ error: "Instructor access denied" }, 403);
  }

  const scope = courseScopeFromAuthContext(authContext, courseId);
  if (!scope) return c.json({ error: "Course access denied" }, 403);

  const db = makeDb(c.env.DATABASE_URL);
  // Constructed exactly as profile.ts's getProfileHandler/patchProfileHandler
  // already do -- the one existing precedent for building a cipher from
  // c.env at the route layer.
  const cipher = new IdentityCipher(await loadIdentityCipherKeys(c.env));
  const matrix = await getHomeworkSubmissionsMatrix(db, scope, cipher, homeworkId!);
  if (!matrix) return c.json({ error: "Homework not found" }, 404);
  return c.json(matrix);
}

// Sub-app preserved for direct unit testing; production routing happens via
// app.post("/api/conversations/:id/submit", ...) in server/index.ts (see
// homeworks.ts / studentHomeworks.ts for the same pattern).
export const submissionsRoutes = new Hono<AppEnv>();
submissionsRoutes.post("/:id/submit", requireRole(["student"])(submitSectionHandler));
