import { Effect } from "effect";
import { UUID_RE } from "../utils/uuid";
import {
  upsertSectionAnswer,
  getSectionAnswer,
  SectionAnswerSectionNotFoundError,
  SectionNotAnswerableError,
  SectionAnswerHomeworkClosedError,
} from "../repositories/sectionAnswers";
import { getOrgScopesForUser } from "../repositories/users";
import { isUnreleased } from "../repositories/homeworks";
import { courseScopeFromAuthContext } from "../repositories/scope";
import type { SectionAnswerBody, SectionAnswerResponse } from "../../shared/types";
import { BadRequest, Forbidden, NotFound } from "../effect/errors";
import { effectHandler } from "../effect/http";
import { query } from "../effect/services";

/** Uniform 403 for every upsertSectionAnswer refusal -- see the catchTags
 *  below for why they must not be told apart. */
const notAnswerable = () => new Forbidden({ message: "Section not found or does not accept a direct answer" });
const answerNotFound = () => new NotFound({ message: "Answer not found" });

export const submitSectionAnswerHandler = effectHandler((c) => Effect.gen(function* () {
  const sectionId = c.req.param("sectionId");
  const authContext = c.get("authContext");

  // requireRole(["student"]) already verified this when reached via the
  // guarded production route; re-checked here -- mirrors submitSectionHandler
  // (routes/submissions.ts) -- so the handler fails closed even if reached
  // unguarded, rather than throwing past this point into the generic 503.
  if (!authContext || !authContext.hasRole("student")) {
    return yield* new Forbidden({ message: "Insufficient permissions" });
  }

  const body = yield* Effect.tryPromise({
    try: () => c.req.json<SectionAnswerBody>(),
    catch: () => new BadRequest({ message: "Request body must be valid JSON" }),
  });
  if (typeof body.content !== "string" || body.content.trim() === "") {
    return yield* new BadRequest({ message: "content is required" });
  }
  const content = body.content;

  // #267/SEC-020 convention: a malformed id must not reach a uuid-typed
  // column. It used to, and the bare catch below turned Postgres's
  // `invalid input syntax` into this route's 403; with the refusals now
  // typed that error would be a 503, so the guard keeps the 403 -- the same
  // uniform body, so shape is no existence oracle.
  if (!sectionId || !UUID_RE.test(sectionId)) {
    return yield* notAnswerable();
  }

  // Same single-org-per-user assumption submitSectionHandler already makes
  // (routes/submissions.ts) -- upsertSectionAnswer's own ownership check via
  // the real parent chain is what actually narrows this to the right org.
  const orgScopes = yield* query(
    "getOrgScopesForUser",
    (db) => getOrgScopesForUser(db, authContext.session.userId),
  );
  const orgScope = orgScopes[0];
  if (!orgScope) return yield* new Forbidden({ message: "No organization membership found" });

  const answer = yield* query(
    "upsertSectionAnswer",
    (db) => upsertSectionAnswer(db, orgScope, sectionId, authContext.session.userId, content),
    [SectionAnswerSectionNotFoundError, SectionNotAnswerableError, SectionAnswerHomeworkClosedError],
  ).pipe(Effect.catchTags({
    // Uniform 403 for "section not found in this org", "section isn't
    // non_interactive" and "homework hidden/expired" -- same rationale as
    // submitSectionHandler's own uniform 403: don't let a not-found-vs-
    // wrong-type distinction leak section existence to a caller who
    // shouldn't see it. Anything else is a DatabaseError (503, logged); the
    // old bare catch reported a dropped connection as this 403.
    SectionAnswerSectionNotFoundError: () => Effect.fail(notAnswerable()),
    SectionNotAnswerableError: () => Effect.fail(notAnswerable()),
    SectionAnswerHomeworkClosedError: () => Effect.fail(notAnswerable()),
  }));
  const responseBody: SectionAnswerResponse = {
    id: answer.id,
    sectionId: answer.sectionId,
    userId: answer.userId,
    content: answer.content,
    submittedAt: answer.submittedAt.toISOString(),
    updatedAt: answer.updatedAt.toISOString(),
  };
  return c.json(responseBody);
}));

export const getSectionAnswerHandler = effectHandler((c) => Effect.gen(function* () {
  const courseId = c.req.param("courseId");
  const sectionId = c.req.param("sectionId");
  const studentId = c.req.param("studentId");
  const authContext = c.get("authContext");

  // #172: grading authority, not authoring -- a TA may read a student's
  // answer for the course they assist on.
  if (!authContext || !courseId || !authContext.isGraderOf(courseId)) {
    return yield* new Forbidden({ message: "Grader access denied" });
  }

  // #174: mint a CourseScope, not an OrgScope -- isGraderOf(courseId)
  // above only proves membership in *this* course, so the query below must
  // stay constrained to it rather than widening to the whole org.
  const scope = courseScopeFromAuthContext(authContext, courseId);
  if (!scope) return yield* new Forbidden({ message: "Course access denied" });

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
  if (!sectionId || !UUID_RE.test(sectionId) || !studentId || !UUID_RE.test(studentId)) {
    return yield* answerNotFound();
  }

  const answer = yield* query(
    "getSectionAnswer",
    (db) => getSectionAnswer(db, scope, sectionId, studentId),
  );
  if (!answer) return yield* answerNotFound();

  // #172 audit (SEC-001): same gate as the submissions dashboard and the
  // homework detail route -- grading authority does not carry access to a
  // homework the instructor has withdrawn from release.
  if (!authContext.canViewDraftsIn(courseId) && isUnreleased(answer.homeworkStatus)) {
    return yield* answerNotFound();
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
}));
