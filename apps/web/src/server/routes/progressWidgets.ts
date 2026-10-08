import { Effect } from "effect";
import { UUID_RE } from "../utils/uuid";
import { submitWidgetResponse, WidgetNotFoundError } from "../repositories/progressWidgets";
import { getOrgScopesForUser } from "../repositories/users";
import type { WidgetResponseBody, WidgetResponseResponse } from "../../shared/types";
import { BadRequest, Forbidden } from "../effect/errors";
import { effectHandler } from "../effect/http";
import { query } from "../effect/services";

/** Uniform 403 -- same rationale as submitSectionAnswerHandler: don't let a
 *  not-found distinction leak widget existence. */
const widgetNotFound = () => new Forbidden({ message: "Widget not found in this org scope" });

export const submitWidgetResponseHandler = effectHandler((c) => Effect.gen(function* () {
  const widgetId = c.req.param("widgetId");
  const authContext = c.get("authContext");

  // requireRole(["student"]) already verified this when reached via the
  // guarded production route; re-checked here -- mirrors
  // submitSectionAnswerHandler (routes/sectionAnswers.ts) -- so the handler
  // fails closed even if reached unguarded.
  if (!authContext || !authContext.hasRole("student")) {
    return yield* new Forbidden({ message: "Insufficient permissions" });
  }

  const body = yield* Effect.tryPromise({
    try: () => c.req.json<WidgetResponseBody>(),
    catch: () => new BadRequest({ message: "Request body must be valid JSON" }),
  });
  const which = body.which;
  if (which !== "pre" && which !== "post") {
    return yield* new BadRequest({ message: "which must be \"pre\" or \"post\"" });
  }
  const value = body.value;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 10) {
    return yield* new BadRequest({ message: "value must be an integer between 0 and 10" });
  }

  // #267/SEC-020 convention: a malformed id must not reach a uuid-typed
  // column. The old bare catch turned Postgres's `invalid input syntax` into
  // the 403 below; with the refusal now typed it would be a 503, so the
  // guard keeps the same uniform 403.
  if (!widgetId || !UUID_RE.test(widgetId)) {
    return yield* widgetNotFound();
  }

  // Same single-org-per-user assumption submitSectionAnswerHandler already
  // makes -- submitWidgetResponse's own ownership check via the real
  // parent chain is what actually narrows this to the right org.
  const orgScopes = yield* query(
    "getOrgScopesForUser",
    (db) => getOrgScopesForUser(db, authContext.session.userId),
  );
  const orgScope = orgScopes[0];
  if (!orgScope) return yield* new Forbidden({ message: "No organization membership found" });

  const response = yield* query(
    "submitWidgetResponse",
    (db) => submitWidgetResponse(db, orgScope, widgetId, authContext.session.userId, { which, value }),
    [WidgetNotFoundError],
  ).pipe(Effect.catchTags({
    // Anything else is a DatabaseError (503, logged); the old bare catch
    // reported a dropped connection as this 403.
    WidgetNotFoundError: () => Effect.fail(widgetNotFound()),
  }));
  const responseBody: WidgetResponseResponse = {
    id: response.id,
    widgetId: response.widgetId,
    userId: response.userId,
    preValue: response.preValue,
    preSubmittedAt: response.preSubmittedAt?.toISOString() ?? null,
    postValue: response.postValue,
    postSubmittedAt: response.postSubmittedAt?.toISOString() ?? null,
  };
  return c.json(responseBody);
}));
