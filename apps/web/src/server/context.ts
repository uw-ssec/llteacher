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
    /** #208: set by requireGraderOf's instrumented AuthContext the first
     *  time a grader-tier handler consults canViewDraftsIn. Exists so the
     *  release-gate pairing can be *observed* rather than assumed -- see
     *  utils/guards.ts. Nothing in production branches on it. */
    draftGateConsulted?: boolean;
  };
}
