import type { Context } from "hono";
import type { AuthContext, CourseRole } from "../middleware/roles";
import type { AppEnv } from "../context";
import { logServerError } from "./errors";

type GuardedHandler = (c: Context<AppEnv>) => Response | Promise<Response>;

function getAuthContext(c: Context<AppEnv>): AuthContext | undefined {
  return c.get("authContext");
}

/** Guards decide *who* (role/membership); org-scoped repositories (M2)
 *  decide *which org's rows* -- the two compose, neither substitutes
 *  for the other. */
export function requireRole(allowedRoles: CourseRole[]) {
  return (handler: GuardedHandler) => async (c: Context<AppEnv>) => {
    const authContext = getAuthContext(c);
    if (!authContext || !allowedRoles.some((role) => authContext.hasRole(role))) {
      return c.json({ error: "Insufficient permissions" }, 403);
    }
    return handler(c);
  };
}

export function requireCourseMember(courseIdParam = "courseId") {
  return (handler: GuardedHandler) => async (c: Context<AppEnv>) => {
    const authContext = getAuthContext(c);
    const courseId = c.req.param(courseIdParam);
    if (!authContext || !courseId || !authContext.isMemberOf(courseId)) {
      return c.json({ error: "Course access denied" }, 403);
    }
    return handler(c);
  };
}

/** Authoring authority. Keep using this for anything that mutates course
 *  content -- create/edit/delete/publish/hide. */
export function requireInstructorOf(courseIdParam = "courseId") {
  return (handler: GuardedHandler) => async (c: Context<AppEnv>) => {
    const authContext = getAuthContext(c);
    const courseId = c.req.param(courseIdParam);
    if (!authContext || !courseId || !authContext.isInstructorOf(courseId)) {
      return c.json({ error: "Instructor access denied" }, 403);
    }
    return handler(c);
  };
}

/** #208 (SEC-001 residual): the release posture a grader-tier route takes.
 *
 *  `requireGraderOf` admits a TA, and a TA holds no draft access unless an
 *  instructor granted it on their membership. So every grader-tier route
 *  that can return unreleased content must gate on `canViewDraftsIn` --
 *  but that check lives in the route body, and nothing paired the two. The
 *  four #172 call sites got it right by their author remembering; the fifth
 *  route was one forgetful afternoon away from handing a TA the drafts of a
 *  course they hold no grant in.
 *
 *  Making this argument required is the forcing function: a new grader-tier
 *  route cannot be registered without its author stating, in the route
 *  table, which of the two cases they are in. Two things then check the
 *  claim rather than trusting it -- releaseGate.test.ts fails until the new
 *  route is listed with its posture (so a reviewer sees it), and the
 *  instrumentation below logs when a `gates-unreleased` route answers 2xx
 *  having never consulted the gate (so a false claim is visible in
 *  production, not only in review). */
export type ReleaseGatePosture =
  /** The handler consults `canViewDraftsIn` and withholds, 404s, or filters
   *  unreleased content itself. */
  | "gates-unreleased"
  /** The route cannot return unreleased content by construction -- e.g. it
   *  reads a table that only holds released rows. Choosing this is a claim
   *  about the data, and the reason belongs in a comment at the call site. */
  | "no-unreleased-content";

/** Key for the posture stamped onto a guarded handler. A symbol rather than
 *  a string property so it cannot collide with anything Hono puts on a
 *  handler, and non-enumerable so it does not show up in diagnostics. */
export const RELEASE_GATE_POSTURE = Symbol("releaseGatePosture");

/** Reads the posture off a guarded handler. Returns undefined for any
 *  handler that did not come from requireGraderOf, which is how the
 *  enumeration test tells grader-tier routes apart from the rest. */
export function releaseGatePostureOf(handler: unknown): ReleaseGatePosture | undefined {
  if (typeof handler !== "function") return undefined;
  return (handler as unknown as Record<symbol, ReleaseGatePosture | undefined>)[
    RELEASE_GATE_POSTURE
  ];
}

/** Grading authority (#172): strictly wider than requireInstructorOf --
 *  admits `ta` alongside instructor/admin. Use this for routes that *read*
 *  student work; keep requireInstructorOf for routes that author content.
 *
 *  Deliberately a separate guard rather than a parameter on
 *  requireInstructorOf: the two answer different questions, and a boolean
 *  flag at each call site would make the wider case easy to select by
 *  accident. The narrower guard stays the default.
 *
 *  #208: `posture` is required -- see ReleaseGatePosture above. On
 *  `gates-unreleased` routes the AuthContext handed to the handler is
 *  wrapped so that consulting `canViewDraftsIn` is recorded on the request.
 *  Production never reads that flag; it exists so a test can assert the
 *  handler did what its registration claims. The wrapper is one object
 *  spread per grader request, which is not a cost worth reasoning about. */
export function requireGraderOf(posture: ReleaseGatePosture, courseIdParam = "courseId") {
  return (handler: GuardedHandler) => {
    const guarded = async (c: Context<AppEnv>) => {
      const authContext = getAuthContext(c);
      const courseId = c.req.param(courseIdParam);
      if (!authContext || !courseId || !authContext.isGraderOf(courseId)) {
        return c.json({ error: "Grader access denied" }, 403);
      }
      if (posture !== "gates-unreleased") return handler(c);

      c.set("authContext", {
        ...authContext,
        canViewDraftsIn: (id: string) => {
          c.set("draftGateConsulted", true);
          return authContext.canViewDraftsIn(id);
        },
      });
      const response = await handler(c);
      // A handler that answered successfully without ever asking whether
      // this caller may see unreleased content has either lost its gate or
      // never had one, and its registration says otherwise. Non-2xx is
      // exempt: a 403/404/400 short-circuit legitimately returns before
      // reaching the gate.
      //
      // Logged rather than thrown. Turning a working route into a 503 on a
      // *suspicion* would be a worse outage than the leak is a risk, and
      // this fires on the release path where a human reads the logs. The
      // compile-time half of the pairing -- `posture` being a required
      // argument -- is what stops the route existing in the first place;
      // this catches the case where the argument is a lie.
      if (response.ok && !c.get("draftGateConsulted")) {
        logServerError(
          "requireGraderOf",
          new Error(
            `${c.req.method} ${c.req.path} is registered "gates-unreleased" but returned ` +
              `${response.status} without consulting canViewDraftsIn -- a TA may be reading ` +
              `unreleased content they hold no grant for (#208)`,
          ),
        );
      }
      return response;
    };
    Object.defineProperty(guarded, RELEASE_GATE_POSTURE, {
      value: posture,
      enumerable: false,
    });
    return guarded;
  };
}
