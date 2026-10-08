import { Effect } from "effect";
import { UUID_RE } from "../utils/uuid";
import {
  submitSection,
  getHomeworkSubmissionsMatrix,
  TeacherTestNotSubmittableError,
  HomeworkClosedError,
  ConversationNotSubmittableError,
  NotSubmissionOwnerError,
} from "../repositories/submissions";
import { isUnreleased } from "../repositories/homeworks";
import { getOrgScopesForUser } from "../repositories/users";
import { courseScopeFromAuthContext } from "../repositories/scope";
import { loadIdentityCipherKeys } from "../../lib/secrets-loader";
import { IdentityCipher } from "../../lib/crypto/identity-cipher";
import type { SubmissionResponse } from "../../shared/types";
import { Conflict, Forbidden, NotFound } from "../effect/errors";
import { effectHandler } from "../effect/http";
import { query } from "../effect/services";

/** The uniform refusal both submitSection ownership refusals collapse to --
 *  see submitSectionHandler's own comments for why they must match. */
const notAccessible = () => new Forbidden({ message: "Conversation not found or not accessible" });
const homeworkNotFound = () => new NotFound({ message: "Homework not found" });

export const submitSectionHandler = effectHandler((c) => Effect.gen(function* () {
  const conversationId = c.req.param("id");
  const authContext = c.get("authContext");

  // requireRole(["student"]) already verified authContext exists and has the
  // student role when this handler is reached via the guarded production
  // route; guarded again here -- mirrors studentHomeworksHandler in
  // routes/studentHomeworks.ts -- so the handler fails closed with a 403
  // even if reached unguarded, rather than throwing past this point (e.g.
  // on the getOrgScopesForUser call below) into the generic 503 handler.
  if (!authContext || !authContext.hasRole("student")) {
    return yield* new Forbidden({ message: "Insufficient permissions" });
  }

  // #267 fixed this class of bug on every other `:id` route in the app --
  // conversations.ts's PATCH/DELETE/messages handlers, sectionConversations.ts
  // -- and missed this one. Without the guard a malformed id reaches Postgres,
  // raises `invalid input syntax for type uuid`, and app.onError turns that
  // permanent client error into a 503, so any authenticated student can make
  // the service report itself as down on attacker-chosen input.
  //
  // Returns this route's OWN refusal body and status, not a 404: the two
  // repository refusals below are deliberately collapsed into one opaque 403
  // so a non-owner cannot tell "no such conversation" from "not yours". A
  // distinct status or message for a malformed id would reopen that split
  // from the other side.
  if (!conversationId || !UUID_RE.test(conversationId)) {
    return yield* notAccessible();
  }

  // A student's conversation belongs to exactly one org via its course;
  // getOrgScopesForUser (existing, repositories/users.ts) returns every org
  // scope reachable through the caller's own non-dropped memberships --
  // submitSection's own conversation-ownership check (Task 16) is what
  // actually narrows this to the right one, this is just picking an org to
  // scope the query by (a student only ever belongs to one org in the
  // current single-org-per-user model this repo assumes elsewhere).
  const orgScopes = yield* query(
    "getOrgScopesForUser",
    (db) => getOrgScopesForUser(db, authContext.session.userId),
  );
  const orgScope = orgScopes[0];
  if (!orgScope) return yield* new Forbidden({ message: "No organization membership found" });

  const result = yield* query(
    "submitSection",
    (db) => submitSection(db, orgScope, conversationId, authContext.session.userId),
    [
      TeacherTestNotSubmittableError,
      HomeworkClosedError,
      ConversationNotSubmittableError,
      NotSubmissionOwnerError,
    ],
  ).pipe(Effect.catchTags({
    // #242: the caller owns this conversation -- it is their own test run --
    // so naming the real reason leaks nothing, and "not found or not
    // accessible" would be simply false.
    TeacherTestNotSubmittableError: (err) => Effect.fail(new Conflict({ message: err.message })),
    // #251: the homework closing is a state the student can act on and
    // already had access to -- "not found" would send them hunting a bug
    // that isn't there.
    HomeworkClosedError: (err) => Effect.fail(new Conflict({ message: err.message })),
    // submitSection throws these two distinctly -- deliberately mapped to the
    // same uniform 403 here rather than distinguished, so a non-owner can't
    // use a 404-vs-403 split to learn a conversation exists.
    ConversationNotSubmittableError: () => Effect.fail(notAccessible()),
    NotSubmissionOwnerError: () => Effect.fail(notAccessible()),
  }));
  // #251: anything else is not a refusal this route knows how to translate --
  // a DatabaseError (effect/services.ts's query), logged and answered 503 --
  // the same standard #236 applied to the section-conversation handlers.
  const body: SubmissionResponse = {
    id: result.id,
    conversationId: result.conversationId,
    submittedAt: result.submittedAt.toISOString(),
    isResubmission: result.isResubmission,
  };
  return c.json(body, result.isResubmission ? 200 : 201);
}));

export const getHomeworkSubmissionsHandler = effectHandler((c) => Effect.gen(function* () {
  const courseId = c.req.param("courseId");
  const homeworkId = c.req.param("homeworkId");
  const authContext = c.get("authContext");

  // Guarded again here even though production routing already wraps this
  // handler in requireGraderOf() -- mirrors submitSectionHandler's own
  // fail-closed re-check above, so a direct call to the handler (as the
  // unit tests below do, and as buildSubmissionsApp does without the guard
  // middleware) still 403s rather than throwing past this point.
  // #172: grading authority, not authoring -- a TA may read this dashboard.
  if (!authContext || !courseId || !authContext.isGraderOf(courseId)) {
    return yield* new Forbidden({ message: "Grader access denied" });
  }

  const scope = courseScopeFromAuthContext(authContext, courseId);
  if (!scope) return yield* new Forbidden({ message: "Course access denied" });

  // Constructed exactly as profile.ts's getProfileHandler/patchProfileHandler
  // already do -- the one existing precedent for building a cipher from
  // c.env at the route layer. A missing/invalid key is a deployment fault,
  // not a request outcome: Effect.promise makes it a defect (logged, 503),
  // as app.onError answered it before.
  const cipher = new IdentityCipher(yield* Effect.promise(() => loadIdentityCipherKeys(c.env)));
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
    return yield* homeworkNotFound();
  }

  const matrix = yield* query(
    "getHomeworkSubmissionsMatrix",
    (db) => getHomeworkSubmissionsMatrix(db, scope, cipher, homeworkId),
  );
  if (!matrix) return yield* homeworkNotFound();
  // #172 audit (SEC-001): grading authority does not imply access to
  // unreleased content. A TA the instructor denied `can_view_drafts` must
  // not read a draft/scheduled/hidden homework's title, due date or section
  // titles here after the detail route already 404s them for it. Same 404
  // shape, so the two routes stay indistinguishable to a prober.
  if (!authContext.canViewDraftsIn(courseId) && isUnreleased(matrix.homeworkStatus)) {
    return yield* homeworkNotFound();
  }
  return c.json(matrix);
}));
