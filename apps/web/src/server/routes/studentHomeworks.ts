import { Effect } from "effect";
import { getStudentHomeworksForUser } from "../repositories/studentHomeworks";
import type { StudentHomeworkListResponse } from "../../shared/types";
import { Forbidden } from "../effect/errors";
import { effectHandler } from "../effect/http";
import { query } from "../effect/services";

export const studentHomeworksHandler = effectHandler((c) => Effect.gen(function* () {
  const authContext = c.get("authContext");

  // requireRole(["student"]) already verified authContext exists and has the
  // student role when this handler is reached via the guarded production
  // route; guarded again here -- mirrors listHomeworksHandler/
  // updateHomeworkHandler in routes/homeworks.ts -- so the handler fails
  // closed with a 403 even if reached unguarded, rather than throwing past
  // this point into the generic 503 handler.
  if (!authContext || !authContext.hasRole("student")) {
    return yield* new Forbidden({ message: "Course access denied" });
  }

  const homeworksList = yield* query(
    "getStudentHomeworksForUser",
    (db) => getStudentHomeworksForUser(db, authContext.session.userId),
  );
  const body: StudentHomeworkListResponse = { homeworks: homeworksList };
  return c.json(body);
}));
