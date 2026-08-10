import { type Context } from "hono";
import { makeDb } from "../../db/client";
import { upsertSectionAnswer, getSectionAnswer } from "../repositories/sectionAnswers";
import { getOrgScopesForUser } from "../repositories/users";
import { isUnreleased } from "../repositories/homeworks";
import { courseScopeFromAuthContext } from "../repositories/scope";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import type { SectionAnswerBody, SectionAnswerResponse } from "../../shared/types";

export async function submitSectionAnswerHandler(c: Context<AppEnv>) {
  const sectionId = c.req.param("sectionId");
  const authContext = c.get("authContext") as AuthContext | undefined;

  // requireRole(["student"]) already verified this when reached via the
  // guarded production route; re-checked here -- mirrors submitSectionHandler
  // (routes/submissions.ts) -- so the handler fails closed even if reached
  // unguarded, rather than throwing past this point into the generic 503.
  if (!authContext || !authContext.hasRole("student")) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  let body: SectionAnswerBody;
  try {
    body = await c.req.json<SectionAnswerBody>();
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }
  if (typeof body.content !== "string" || body.content.trim() === "") {
    return c.json({ error: "content is required" }, 400);
  }

  const db = makeDb(c.env.DATABASE_URL);
  // Same single-org-per-user assumption submitSectionHandler already makes
  // (routes/submissions.ts) -- upsertSectionAnswer's own ownership check via
  // the real parent chain is what actually narrows this to the right org.
  const orgScopes = await getOrgScopesForUser(db, authContext.session.userId);
  const orgScope = orgScopes[0];
  if (!orgScope) return c.json({ error: "No organization membership found" }, 403);

  try {
    const answer = await upsertSectionAnswer(db, orgScope, sectionId!, authContext.session.userId, body.content);
    const responseBody: SectionAnswerResponse = {
      id: answer.id,
      sectionId: answer.sectionId,
      userId: answer.userId,
      content: answer.content,
      submittedAt: answer.submittedAt.toISOString(),
      updatedAt: answer.updatedAt.toISOString(),
    };
    return c.json(responseBody);
  } catch {
    // Uniform 403 for both "section not found in this org" and "section
    // isn't non_interactive" -- same rationale as submitSectionHandler's
    // own uniform 403: don't let a not-found-vs-wrong-type distinction leak
    // section existence to a caller who shouldn't see it.
    return c.json({ error: "Section not found or does not accept a direct answer" }, 403);
  }
}

export async function getSectionAnswerHandler(c: Context<AppEnv>) {
  const courseId = c.req.param("courseId");
  const sectionId = c.req.param("sectionId");
  const studentId = c.req.param("studentId");
  const authContext = c.get("authContext") as AuthContext | undefined;

  // #172: grading authority, not authoring -- a TA may read a student's
  // answer for the course they assist on.
  if (!authContext || !courseId || !authContext.isGraderOf(courseId)) {
    return c.json({ error: "Grader access denied" }, 403);
  }

  // #174: mint a CourseScope, not an OrgScope -- isGraderOf(courseId)
  // above only proves membership in *this* course, so the query below must
  // stay constrained to it rather than widening to the whole org.
  const scope = courseScopeFromAuthContext(authContext, courseId);
  if (!scope) return c.json({ error: "Course access denied" }, 403);

  const db = makeDb(c.env.DATABASE_URL);
  const answer = await getSectionAnswer(db, scope, sectionId!, studentId!);
  if (!answer) return c.json({ error: "Answer not found" }, 404);

  // #172 audit (SEC-001): same gate as the submissions dashboard and the
  // homework detail route -- grading authority does not carry access to a
  // homework the instructor has withdrawn from release.
  if (!authContext.canViewDraftsIn(courseId) && isUnreleased(answer.homeworkStatus)) {
    return c.json({ error: "Answer not found" }, 404);
  }

  const responseBody: SectionAnswerResponse = {
    id: answer.id,
    sectionId: answer.sectionId,
    userId: answer.userId,
    content: answer.content,
    submittedAt: answer.submittedAt.toISOString(),
    updatedAt: answer.updatedAt.toISOString(),
  };
  return c.json(responseBody);
}

