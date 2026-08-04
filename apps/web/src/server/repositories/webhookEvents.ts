import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { workosWebhookEvents } from "../../db/schema";

/** Intentionally takes no OrgScope/CourseScope, like listMembershipsForUser
 *  (repositories/users.ts) -- WorkOS webhook events aren't tenant data, they're
 *  a global operational log keyed by WorkOS's own (globally unique) event id. */
export async function findWebhookEvent(db: Db, id: string) {
  return db.query.workosWebhookEvents.findFirst({
    where: eq(workosWebhookEvents.id, id),
    columns: { status: true },
  });
}

/** Insert-or-update by id: the first processing attempt for an event id
 *  inserts; a retry of a previously "failed" event updates the same row's
 *  status in place rather than erroring on the primary-key conflict. */
export async function recordWebhookEvent(
  db: Db,
  input: {
    id: string;
    eventType: string;
    payload: unknown;
    status: "processed" | "skipped" | "failed";
  },
) {
  await db
    .insert(workosWebhookEvents)
    .values(input)
    .onConflictDoUpdate({
      target: workosWebhookEvents.id,
      set: { status: input.status },
    });
}
