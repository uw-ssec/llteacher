import { type Context } from "hono";
import { makeDb } from "../../db/client";
import { listLlmConfigsForOrg } from "../repositories/llmConfigs";
import { getOrgScopeForCourse } from "../repositories/organizations";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import type { LLMConfigListResponse } from "../../shared/types";

/** Backs the "LLM config" picker in apps/admin's homework create/edit form.
 *  Without this route the admin app had no way to learn a course's real
 *  llm_configs UUIDs and fell back to hardcoded fixture ids -- selecting one
 *  and saving 400ed against updateHomeworkHandler's UUID_RE check (the
 *  create/PATCH already having created the bare homework by then). */
export async function listLlmConfigsHandler(c: Context<AppEnv>) {
  const courseId = c.req.param("courseId");
  const authContext = c.get("authContext") as AuthContext | undefined;

  // requireInstructorOf already verified this; guarded again here to match
  // every sibling authoring-surface handler in homeworks.ts.
  if (!authContext || !courseId || !authContext.isInstructorOf(courseId)) {
    return c.json({ error: "Course access denied" }, 403);
  }

  const db = makeDb(c.env.DATABASE_URL);
  const orgScope = await getOrgScopeForCourse(db, courseId);
  if (!orgScope) {
    return c.json({ error: "Course access denied" }, 403);
  }

  const rows = await listLlmConfigsForOrg(db, orgScope);
  const body: LLMConfigListResponse = {
    llmConfigs: rows
      .filter((r) => r.isActive)
      .map((r) => ({ id: r.id, provider: r.provider, modelName: r.modelName, isDefault: r.isDefault })),
  };
  return c.json(body);
}
