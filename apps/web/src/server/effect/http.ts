/* --------------------------------------------------------------------------
   Hono <-> Effect bridge.

   `effectHandler` runs a handler's Effect with the request's services and
   turns its outcome into a Response. Its type parameter is bounded by
   `HttpError`, so the error channel must already be reduced to failures
   this module knows how to answer -- a forgotten repository refusal is a
   compile error at the route table, not a 503 discovered in production.

   `errorResponse` is the single status mapping for typed failures, and
   `app.onError` (server/index.ts) uses it too via `fromThrown`, so a
   handler that still throws gets the same answer as one that fails.
   -------------------------------------------------------------------------- */

import type { Context } from "hono";
import { absurd, Cause, Effect, Exit, Option } from "effect";
import type { AppEnv } from "../context";
import type { AuthContext } from "../middleware/roles";
import { courseScopeFromAuthContext, type CourseScope } from "../repositories/scope";
import {
  IdempotencyKeyConflictError,
  PromptTemplateConflictError,
  TenancyMismatchError,
} from "../repositories/errors";
import { logServerError, SERVICE_UNAVAILABLE_MESSAGE } from "../utils/errors";
import {
  BadRequest,
  Conflict,
  DatabaseError,
  ExternalServiceError,
  Forbidden,
  NotFound,
  Unauthorized,
} from "./errors";
import { requestLayer, type RequestServices } from "./services";

/** Every typed failure the bridge can answer. */
export type HttpError =
  | Unauthorized
  | Forbidden
  | BadRequest
  | NotFound
  | Conflict
  | DatabaseError
  | ExternalServiceError
  | TenancyMismatchError
  | IdempotencyKeyConflictError
  | PromptTemplateConflictError;

export type HttpHandler<E extends HttpError> = (
  c: Context<AppEnv>,
) => Effect.Effect<Response, E, RequestServices>;

/** Logs a dependency failure with its classification. Request outcomes are
 *  not logged: they are the response. */
function logDependencyFailure(c: Context<AppEnv>, error: DatabaseError | ExternalServiceError) {
  const where = { method: c.req.method, path: c.req.path, tag: error._tag, operation: error.operation };
  logServerError(
    "server",
    error.cause,
    error._tag === "DatabaseError" ? { ...where, reason: error.reason } : { ...where, service: error.service },
  );
}

/** The one status/body mapping for typed failures. Exhaustive: adding a
 *  member to HttpError without a case here fails the build at `absurd`. */
export function errorResponse(c: Context<AppEnv>, error: HttpError): Response {
  switch (error._tag) {
    case "Unauthorized":
      return c.json({ error: "Unauthorized" }, 401);
    case "Forbidden":
      return c.json({ error: error.message }, 403);
    case "BadRequest":
      return c.json({ error: error.message }, 400);
    case "NotFound":
      return c.json({ error: error.message }, 404);
    case "Conflict":
      return c.json(error.code ? { error: error.message, code: error.code } : { error: error.message }, 409);
    // #141: never 403 -- a guessed id must not confirm a row exists.
    case "TenancyMismatchError":
      return c.json({ error: "Not found" }, 404);
    // #266: same `code` chat.ts returns, so readErrorMessage treats both alike.
    case "IdempotencyKeyConflictError":
      return c.json({ error: error.message, code: "duplicate_message" }, 409);
    case "PromptTemplateConflictError":
      return c.json({ error: error.message }, 409);
    case "DatabaseError":
    case "ExternalServiceError":
      logDependencyFailure(c, error);
      return c.json({ error: SERVICE_UNAVAILABLE_MESSAGE }, 503);
    default:
      return absurd(error);
  }
}

/** Recognises a thrown value that already has a typed answer. */
export function fromThrown(err: unknown): HttpError | undefined {
  if (
    err instanceof TenancyMismatchError
    || err instanceof IdempotencyKeyConflictError
    || err instanceof PromptTemplateConflictError
  ) {
    return err;
  }
  return undefined;
}

/** Runs a request-scoped Effect with the request's services. Resolves to
 *  the success value, or to the Response that answers its failure. Defects
 *  (a thrown bug, an interruption) are logged and answered 503, matching
 *  app.onError. Middleware uses this directly so that `next()` stays
 *  outside the Effect and downstream throws still reach app.onError. */
export async function runEffect<A, E extends HttpError>(
  c: Context<AppEnv>,
  effect: Effect.Effect<A, E, RequestServices>,
): Promise<{ ok: true; value: A } | { ok: false; response: Response }> {
  const exit = await Effect.runPromiseExit(effect.pipe(Effect.provide(requestLayer(c.env))));
  if (Exit.isSuccess(exit)) return { ok: true, value: exit.value };
  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isSome(failure)) return { ok: false, response: errorResponse(c, failure.value) };
  logServerError("server", Cause.squash(exit.cause), { method: c.req.method, path: c.req.path, tag: "Defect" });
  return { ok: false, response: c.json({ error: SERVICE_UNAVAILABLE_MESSAGE }, 503) };
}

/** Wraps an Effect handler as a Hono handler. */
export function effectHandler<E extends HttpError>(handler: HttpHandler<E>) {
  return async (c: Context<AppEnv>): Promise<Response> => {
    const outcome = await runEffect(c, Effect.suspend(() => handler(c)));
    return outcome.ok ? outcome.value : outcome.response;
  };
}

/** The caller's resolved AuthContext. authMiddleware/rolesMiddleware gate
 *  every /api/* route; this re-check makes a direct call fail closed. */
export function requireAuthContext(c: Context<AppEnv>): Effect.Effect<AuthContext, Unauthorized> {
  const authContext = c.get("authContext");
  return authContext ? Effect.succeed(authContext) : Effect.fail(new Unauthorized());
}

export type CourseAccess = { authContext: AuthContext; courseId: string; scope: CourseScope };

/** The caller's AuthContext plus the CourseScope for the course in the path
 *  -- the only sanctioned way to mint a scope from request input (see
 *  scope.ts). A non-member, a missing param, and a missing session all get
 *  the same 403 body, so the check is no membership oracle. */
export function requireCourseAccess(
  c: Context<AppEnv>,
  courseIdParam = "courseId",
  message = "Course access denied",
): Effect.Effect<CourseAccess, Forbidden> {
  const authContext = c.get("authContext");
  const courseId = c.req.param(courseIdParam);
  const scope = authContext && courseId ? courseScopeFromAuthContext(authContext, courseId) : null;
  return authContext && courseId && scope
    ? Effect.succeed({ authContext, courseId, scope })
    : Effect.fail(new Forbidden({ message }));
}
