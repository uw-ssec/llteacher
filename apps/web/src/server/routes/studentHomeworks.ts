import { type Context } from "hono";
import { makeDb } from "../../db/client";
import { getStudentHomeworksForUser } from "../repositories/studentHomeworks";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import type { StudentHomeworkListResponse } from "../../shared/types";

export async function studentHomeworksHandler(c: Context<AppEnv>) {
  const authContext = c.get("authContext") as AuthContext | undefined;

  // requireRole(["student"]) already verified authContext exists and has the
  // student role when this handler is reached via the guarded production
  // route; guarded again here -- mirrors listHomeworksHandler/
  // updateHomeworkHandler in routes/homeworks.ts -- so the handler fails
  // closed with a 403 even if reached unguarded, rather than throwing past
  // this point into the generic 503 handler.
  if (!authContext || !authContext.hasRole("student")) {
    return c.json({ error: "Course access denied" }, 403);
  }

  const db = makeDb(c.env.DATABASE_URL);
  const homeworksList = await getStudentHomeworksForUser(db, authContext.session.userId);
  const body: StudentHomeworkListResponse = { homeworks: homeworksList };
  return c.json(body);
}
