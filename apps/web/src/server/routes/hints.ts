import { Effect } from "effect";
import { UUID_RE } from "../utils/uuid";
import { getSectionHintStatus } from "../repositories/hints";
import type { HintCountResponse } from "../../shared/types";
import { NotFound } from "../effect/errors";
import { effectHandler, requireCourseAccess } from "../effect/http";
import { query } from "../effect/services";

/* --------------------------------------------------------------------------
   #80: GET /api/courses/:courseId/sections/:sectionId/hints -- the caller's
   own real hint usage for a section, driving Sidebar's hintCount (replacing
   the #20 fixture). Any course member can read their OWN count (not
   requireRole(["student"]) -- an instructor/TA doing a teacher-test run of
   a section, same population startSectionConversationHandler already
   admits, still needs a real count for their own test conversation rather
   than the client silently defaulting to a stale fixture). Writes (granting
   a hint) happen only through /api/chat's own isHintRequest envelope flag
   (chat.ts), never through this route -- this is read-only.
   -------------------------------------------------------------------------- */
export const getSectionHintsHandler = effectHandler((c) => Effect.gen(function* () {
  const { authContext, scope } = yield* requireCourseAccess(c);
  const sectionId = c.req.param("sectionId");
  // #206/#172 audit (SEC-020): shape-checked before reaching a uuid-typed
  // column comparison -- see getSectionAnswerHandler's identical guard
  // (routes/sectionAnswers.ts) for why a malformed value must 404 here
  // rather than fall through to Postgres's own "invalid input syntax" (a
  // generic 503).
  if (!sectionId || !UUID_RE.test(sectionId)) {
    return yield* new NotFound({ message: "Section not found" });
  }

  const status = yield* query(
    "getSectionHintStatus",
    (db) => getSectionHintStatus(db, scope, sectionId, authContext.session.userId),
  );
  if (!status) return yield* new NotFound({ message: "Section not found" });

  const responseBody: HintCountResponse = status;
  return c.json(responseBody);
}));
