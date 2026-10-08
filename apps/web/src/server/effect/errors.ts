/* --------------------------------------------------------------------------
   Typed failures for Effect-based request handling.

   Every failure a handler can produce is a tagged value in its Effect's
   error channel, so the compiler -- not a reviewer -- checks that each one
   is turned into a response. `HttpError` (http.ts) is the closed set the
   Hono bridge knows how to answer; a handler whose error channel still
   holds anything else (a repository refusal it forgot to translate) does
   not typecheck.

   Two families:
   - Request outcomes (Unauthorized .. Conflict): what the client is told.
   - Dependency failures (DatabaseError, ExternalServiceError): logged with
     their cause, answered with the generic 503 so driver internals never
     reach the client.

   Repository refusals stay the classes their modules already define; each
   carries a `_tag` so Effect.catchTag can name it without these modules
   having to change shape for the code that still uses instanceof.
   -------------------------------------------------------------------------- */

import { Data } from "effect";

/** No authenticated session reached the handler. */
export class Unauthorized extends Data.TaggedError("Unauthorized")<{}> {}

/** Authenticated, but not allowed to act on this resource. */
export class Forbidden extends Data.TaggedError("Forbidden")<{ readonly message: string }> {}

/** The request itself is malformed (path, query, or body). */
export class BadRequest extends Data.TaggedError("BadRequest")<{ readonly message: string }> {}

/** The resource is absent, or the caller may not learn that it exists. */
export class NotFound extends Data.TaggedError("NotFound")<{ readonly message: string }> {}

/** Well-formed and allowed, but the resource's state refuses it. `code` is
 *  the machine-readable reason clients already branch on, when one exists. */
export class Conflict extends Data.TaggedError("Conflict")<{
  readonly message: string;
  readonly code?: string;
}> {}

/** Why a database call failed, from the driver's SQLSTATE/errno -- for the
 *  log line, never the response. */
export type DatabaseFailureReason = "unavailable" | "constraint" | "query";

/** Any failure from Postgres that the calling code did not declare as an
 *  expected refusal. */
export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly operation: string;
  readonly reason: DatabaseFailureReason;
  readonly cause: unknown;
}> {}

export type ExternalService = "workos" | "llm" | "canvas" | "storage" | "knowledge";

/** A third-party dependency failed in a way the caller does not translate. */
export class ExternalServiceError extends Data.TaggedError("ExternalServiceError")<{
  readonly service: ExternalService;
  readonly operation: string;
  readonly cause: unknown;
}> {}

/** Process configuration that is missing or invalid. Collects every problem
 *  at once, so an operator fixes the environment in one pass. */
export class RuntimeConfigError extends Data.TaggedError("RuntimeConfigError")<{
  readonly problems: readonly string[];
}> {
  override get message() {
    return this.problems.join("; ");
  }
}

const UNAVAILABLE_ERRNOS = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN", "EPIPE"]);

/** Classifies a node-postgres failure. SQLSTATE class 08 is a connection
 *  exception, 57P0x is an admin/crash shutdown, 53xxx is resource
 *  exhaustion; class 23 is an integrity-constraint violation. */
export function classifyDatabaseFailure(cause: unknown): DatabaseFailureReason {
  if (typeof cause !== "object" || cause === null) return "query";
  const code = (cause as { code?: unknown }).code;
  if (typeof code === "string") {
    if (UNAVAILABLE_ERRNOS.has(code) || code.startsWith("08") || code.startsWith("57P") || code.startsWith("53")) {
      return "unavailable";
    }
    if (code.startsWith("23")) return "constraint";
  }
  const message = cause instanceof Error ? cause.message : "";
  if (/Connection terminated|timeout exceeded when trying to connect|pool is not initialized/i.test(message)) {
    return "unavailable";
  }
  return "query";
}
