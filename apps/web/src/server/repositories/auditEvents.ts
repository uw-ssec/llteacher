import type { Db } from "../../db/client";
import { auditEvents } from "../../db/schema";
import type { OrgScope } from "./scope";

/** The only write path for audit_events. No update/delete function exists
 *  in this module or anywhere else in the codebase -- that omission is the
 *  M2 append-only enforcement mechanism. */
export async function recordAuditEvent(
  db: Db,
  scope: OrgScope,
  input: {
    actorUserId: string | null;
    action: string;
    targetType: string;
    targetId: string;
    ip?: string;
    requestMetadata?: unknown;
  },
) {
  const [created] = await db
    .insert(auditEvents)
    .values({ organizationId: scope, ...input })
    .returning();
  return created;
}
