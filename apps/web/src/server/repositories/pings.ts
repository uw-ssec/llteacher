import type { Db } from "../../db/client";
import { pings } from "../../db/schema";

/** pings is an unscoped demo table (no org/course tenancy) -- this
 *  repository exists purely to prove routes never import Drizzle directly,
 *  per issue #16's "hello.ts refactor as migration proof" requirement. */
export async function createPing(db: Db, message: string) {
  const [row] = await db.insert(pings).values({ message }).returning();
  return row;
}
