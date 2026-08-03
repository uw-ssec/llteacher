import type { SessionPayload } from "../lib/session";
import type { AuthContext } from "./middleware/roles";

/** Shared Hono generic for every route/middleware in this app. Variables
 *  accumulates everything middleware attaches via c.set(): authMiddleware
 *  sets `session`, rolesMiddleware sets `authContext`. */
export interface AppEnv {
  Bindings: Env;
  Variables: {
    session?: SessionPayload;
    authContext?: AuthContext;
  };
}
