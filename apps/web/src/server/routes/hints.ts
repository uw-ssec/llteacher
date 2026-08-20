import { type Context } from "hono";
import { makeDb } from "../../db/client";
import { UUID_RE } from "../utils/uuid";
import { getSectionHintStatus } from "../repositories/hints";
import { courseScopeFromAuthContext } from "../repositories/scope";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import type { HintCountResponse } from "../../shared/types";

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
export async function getSectionHintsHandler(c: Context<AppEnv>) {
  const courseId = c.req.param("courseId");
  const sectionId = c.req.param("sectionId");
  const authContext = c.get("authContext") as AuthContext | undefined;

  const scope = authContext && courseId ? courseScopeFromAuthContext(authContext, courseId) : null;
  if (!scope || !authContext) {
    return c.json({ error: "Course access denied" }, 403);
  }
  // #206/#172 audit (SEC-020): shape-checked before reaching a uuid-typed
  // column comparison -- see getSectionAnswerHandler's identical guard
  // (routes/sectionAnswers.ts) for why a malformed value must 404 here
  // rather than fall through to Postgres's own "invalid input syntax" (a
  // generic 503 via app.onError).
  if (!sectionId || !UUID_RE.test(sectionId)) {
    return c.json({ error: "Section not found" }, 404);
  }

  const db = makeDb(c.env.DATABASE_URL);
  const status = await getSectionHintStatus(db, scope, sectionId, authContext.session.userId);
  if (!status) return c.json({ error: "Section not found" }, 404);

  const responseBody: HintCountResponse = status;
  return c.json(responseBody);
}
