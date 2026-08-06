import { Hono, type Context } from "hono";
import { makeDb } from "../../db/client";
import { submitSection } from "../repositories/submissions";
import { getOrgScopesForUser } from "../repositories/users";
import { requireRole } from "../utils/guards";
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

// Sub-app preserved for direct unit testing; production routing happens via
// app.post("/api/conversations/:id/submit", ...) in server/index.ts (see
// homeworks.ts / studentHomeworks.ts for the same pattern).
export const submissionsRoutes = new Hono<AppEnv>();
submissionsRoutes.post("/:id/submit", requireRole(["student"])(submitSectionHandler));
