import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { llmConfigs } from "../../db/schema";
import type { OrgScope } from "./scope";

export async function listLlmConfigsForOrg(db: Db, scope: OrgScope) {
  return db.select().from(llmConfigs).where(eq(llmConfigs.organizationId, scope));
}

export async function getDefaultLlmConfig(db: Db, scope: OrgScope) {
  const [found] = await db
    .select()
    .from(llmConfigs)
    .where(and(eq(llmConfigs.organizationId, scope), eq(llmConfigs.isDefault, true)));
  return found;
}

/** #161: `homeworks.llm_config_id`'s FK only requires the row to exist
 *  somewhere -- not that it belongs to the caller's tenant. Cheap existence
 *  check under the given org scope, called before writing the id through. */
export async function llmConfigBelongsToOrg(db: Db, scope: OrgScope, id: string): Promise<boolean> {
  const [found] = await db
    .select({ id: llmConfigs.id })
    .from(llmConfigs)
    .where(and(eq(llmConfigs.id, id), eq(llmConfigs.organizationId, scope)));
  return !!found;
}
