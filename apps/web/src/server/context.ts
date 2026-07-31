import type { SessionPayload } from "../lib/session";

/** Shared Hono generic for every route/middleware in this app. Variables
 *  accumulates everything middleware attaches via c.set() -- authMiddleware
 *  sets `session` here; rolesMiddleware (issue #10) extends this with
 *  `authContext`. */
export interface AppEnv {
  Bindings: Env;
  Variables: {
    session?: SessionPayload;
  };
}
