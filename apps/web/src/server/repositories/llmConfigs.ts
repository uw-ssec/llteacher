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
