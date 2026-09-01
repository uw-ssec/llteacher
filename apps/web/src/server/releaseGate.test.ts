/* --------------------------------------------------------------------------
   #208 (SEC-001 residual): the unreleased-content gate on grader-tier routes
   was a convention, not a mechanism.

   `requireGraderOf` admits a TA. A TA sees unreleased homeworks only where
   an instructor granted `canViewDrafts` on their membership. Both gates that
   enforce that live in the route *body* -- so a fifth grader-tier route
   would have shipped with TA access and no release check unless its author
   remembered, and nothing in the tree would have noticed.

   Three things now hold it up, and this file pins the first two:

     1. `posture` is a required argument to requireGraderOf, so a new
        grader-tier route cannot be registered without its author choosing
        between "I gate this" and "this cannot return unreleased content".
        Compile-time.
     2. The route table below is exhaustive over routes carrying a posture,
        derived from the real app. Adding a grader-tier route fails this file
        until it is listed here with its posture -- which is the moment a
        reviewer sees the claim.
     3. The guard logs when a "gates-unreleased" route answers 2xx without
        consulting canViewDraftsIn, i.e. when the claim in (2) is false.
        Runtime; asserted in utils/guards.test.ts.

   What this file deliberately does NOT do: assert that a given handler's
   gate is *correct*. That is each route suite's job (submissions.test.ts,
   sectionAnswers.test.ts). This one answers "is every grader-tier route
   accounted for", which is the question no other test was asking.
   -------------------------------------------------------------------------- */

import { describe, it, expect } from "vitest";
import { app } from "./index";
import { releaseGatePostureOf, type ReleaseGatePosture } from "./utils/guards";

/** Every grader-tier route, with the release posture its registration
 *  claims. Keyed "METHOD path" exactly as Hono records it. */
const EXPECTED: Record<string, ReleaseGatePosture> = {
  "GET /api/courses/:courseId/homeworks/:homeworkId/submissions": "gates-unreleased",
  "GET /api/courses/:courseId/sections/:sectionId/answers/:studentId": "gates-unreleased",
  // #29/#366 merge: a transcript's own content (greeting + replay, built
  // from the section as it stood at conversation-start time) is unreleased
  // content once the underlying homework is currently draft/scheduled/
  // hidden -- both handlers consult canViewDraftsIn themselves before
  // returning a row whose homework is currently unreleased (see
  // routes/instructor/transcripts.ts's own comments at each check).
  "GET /api/courses/:courseId/instructor/transcripts": "gates-unreleased",
  "GET /api/courses/:courseId/instructor/transcripts/:conversationId": "gates-unreleased",
};

function graderTierRoutes(): Record<string, ReleaseGatePosture> {
  const found: Record<string, ReleaseGatePosture> = {};
  for (const route of app.routes) {
    const posture = releaseGatePostureOf(route.handler);
    if (posture) found[`${route.method} ${route.path}`] = posture;
  }
  return found;
}

describe("grader-tier release gate (#208)", () => {
  it("accounts for every route registered with requireGraderOf", () => {
    // toEqual, not a subset check, in both directions on purpose: a new
    // grader-tier route fails as an unexpected key, and deleting one fails
    // as a missing key rather than silently shrinking the coverage this
    // file claims.
    expect(graderTierRoutes()).toEqual(EXPECTED);
  });

  it("stamps a posture on grader-tier handlers and nothing else", () => {
    const stamped = app.routes.filter((r) => releaseGatePostureOf(r.handler) !== undefined);
    const graderPaths = new Set(Object.keys(EXPECTED));
    expect(stamped.length).toBe(graderPaths.size);
    // The negative half: the authoring and member-tier routes registered in
    // index.ts must carry no posture, or `graderTierRoutes` would be
    // reporting on guards it does not describe.
    const unstamped = app.routes.filter((r) => releaseGatePostureOf(r.handler) === undefined);
    expect(unstamped.length).toBeGreaterThan(0);
    for (const route of unstamped) {
      expect(graderPaths.has(`${route.method} ${route.path}`)).toBe(false);
    }
  });
});
