/* --------------------------------------------------------------------------
   Request dependencies as Effect services.

   A handler states what it needs in its Effect's requirement channel
   (`Database`, `AppConfig`) instead of reaching for `makeDb(c.env...)`
   itself. `requestLayer` is the one place those are built from the Hono
   bindings; tests substitute either service with `Effect.provideService`
   or their own Layer, and a handler that needs a service nobody provides
   does not typecheck.
   -------------------------------------------------------------------------- */

import { Context, Effect, Layer } from "effect";
import { makeDb, type Db } from "../../db/client";
import { classifyDatabaseFailure, DatabaseError, ExternalServiceError, type ExternalService } from "./errors";

export class AppConfig extends Context.Service<AppConfig, Env>()("llteacher/AppConfig") {}

export class Database extends Context.Service<Database, Db>()("llteacher/Database") {}

/** The process-owned pool for the configured DATABASE_URL. `makeDb` throws
 *  only when a different URL is already active; that is a deployment fault,
 *  surfaced as an unavailable database rather than a crash. */
export const DatabaseLive = Layer.effect(
  Database,
  Effect.gen(function* () {
    const config = yield* AppConfig;
    return yield* Effect.try({
      try: () => makeDb(config.DATABASE_URL),
      catch: (cause) => new DatabaseError({ operation: "connect", reason: "unavailable", cause }),
    });
  }),
);

/** Everything a request handler may require, built from one request's env. */
export const requestLayer = (env: Env) =>
  DatabaseLive.pipe(Layer.provideMerge(Layer.succeed(AppConfig, env)));

export type RequestServices = AppConfig | Database;

type ErrorClass = abstract new (...args: any[]) => Error;

/**
 * Runs one repository call against the request's database.
 *
 * `expected` lists the refusal classes this call is documented to throw;
 * they stay in the error channel with their own types. Anything else the
 * promise rejects with is a DatabaseError, classified for the log. Listing
 * a class here is the claim "this call can fail this way" -- the handler
 * then has to answer it before the bridge will accept the Effect.
 */
export function query<A, const Expected extends readonly ErrorClass[] = []>(
  operation: string,
  run: (db: Db) => Promise<A>,
  expected?: Expected,
): Effect.Effect<A, InstanceType<Expected[number]> | DatabaseError, Database> {
  return Effect.gen(function* () {
    const db = yield* Database;
    return yield* Effect.tryPromise({
      try: () => run(db),
      catch: (cause): InstanceType<Expected[number]> | DatabaseError => {
        if (expected?.some((errorClass) => cause instanceof errorClass)) {
          return cause as InstanceType<Expected[number]>;
        }
        return new DatabaseError({ operation, reason: classifyDatabaseFailure(cause), cause });
      },
    });
  });
}

/**
 * Runs one call to a third-party dependency (WorkOS, the LLM gateway,
 * Canvas, object storage, the okf knowledge CLI). Same contract as `query`:
 * `expected` classes keep their own types, anything else is an
 * ExternalServiceError naming the service, logged and answered 503.
 */
export function external<A, const Expected extends readonly ErrorClass[] = []>(
  service: ExternalService,
  operation: string,
  run: () => Promise<A>,
  expected?: Expected,
): Effect.Effect<A, InstanceType<Expected[number]> | ExternalServiceError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause): InstanceType<Expected[number]> | ExternalServiceError => {
      if (expected?.some((errorClass) => cause instanceof errorClass)) {
        return cause as InstanceType<Expected[number]>;
      }
      return new ExternalServiceError({ service, operation, cause });
    },
  });
}
