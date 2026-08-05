import { eq, lt } from "drizzle-orm";
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

/** Fields safe to keep from a WorkOS event's `data` object (#150): this is
 *  an allowlist, not a blocklist -- a field not named here is dropped,
 *  including any PII a future WorkOS event type introduces that this list
 *  doesn't yet know about. Everything else this app encrypts at rest
 *  (`encryptedText`/blind-index columns, `IdentityCipher`) or never stores
 *  in the first place; a plaintext operational log defeats that model the
 *  moment it holds an email or name. `id` is kept because it's the WorkOS
 *  subject id (workosUserId), not PII, and useful for correlating this row
 *  back to a user without decrypting anything. */
const SAFE_PAYLOAD_FIELDS = new Set([
  "id",
  "object",
  "event",
  "emailVerified",
  "lastSignInAt",
  "locale",
  "createdAt",
  "updatedAt",
  "externalId",
]);

function redactPayload(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null) return payload;
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (SAFE_PAYLOAD_FIELDS.has(key)) redacted[key] = value;
  }
  return redacted;
}

/** Atomically claims an event id before any processing happens (#151),
 *  closing the TOCTOU window a separate find-then-later-insert had: two
 *  concurrent identical deliveries could both pass a SELECT-based dedup
 *  check before either had written anything. A single
 *  INSERT ... ON CONFLICT ... DO UPDATE ... WHERE statement is atomic in
 *  Postgres, so only one of two racing claims for the same id can win:
 *  - No row exists yet: the INSERT itself succeeds, claimed.
 *  - A row exists with status 'failed' (a genuine prior processing
 *    failure, safe to retry): the conflict UPDATE's WHERE matches, status
 *    flips to 'claimed', claimed.
 *  - A row exists with any other status ('claimed' by a concurrent
 *    request that's still processing, or already 'processed'/'skipped'):
 *    the WHERE doesn't match, nothing is updated, RETURNING yields no row
 *    -- the caller loses the race and treats this as a duplicate.
 *  Returns true if this call won the claim, false otherwise. */
export async function claimWebhookEvent(
  db: Db,
  input: { id: string; eventType: string },
): Promise<boolean> {
  const [claimed] = await db
    .insert(workosWebhookEvents)
    .values({ id: input.id, eventType: input.eventType, payload: {}, status: "claimed" })
    .onConflictDoUpdate({
      target: workosWebhookEvents.id,
      set: { status: "claimed" },
      setWhere: eq(workosWebhookEvents.status, "failed"),
    })
    .returning({ id: workosWebhookEvents.id });
  return Boolean(claimed);
}

/** Settles a claimed event to its final status (and real, redacted
 *  payload) once processing finishes -- the caller must have already won
 *  claimWebhookEvent for this id. Also used directly by callers that don't
 *  claim first (existing tests, and any future non-webhook caller of this
 *  table) via the same insert-or-update shape claimWebhookEvent uses.
 *  Redacts the payload before it ever reaches the database (#150) -- the
 *  write boundary, not the caller, is what guarantees no plaintext PII
 *  lands in this table, including for any future caller that forgets to
 *  redact at the call site. Updates payload on conflict too, not just
 *  status -- claimWebhookEvent's own insert used an empty placeholder
 *  payload, which must not survive as the final stored value. */
export async function recordWebhookEvent(
  db: Db,
  input: {
    id: string;
    eventType: string;
    payload: unknown;
    status: "processed" | "skipped" | "failed";
  },
) {
  const redacted = redactPayload(input.payload);
  await db
    .insert(workosWebhookEvents)
    .values({ ...input, payload: redacted })
    .onConflictDoUpdate({
      target: workosWebhookEvents.id,
      set: { status: input.status, payload: redacted },
    });
}

/** Retention (#150): this table has no enforcement-layer TTL yet (no
 *  Cloudflare Cron Trigger is wired to call this -- that's real
 *  scheduling infrastructure, tracked separately under M12, not something
 *  to fake here). This is the purge query a future cron handler calls;
 *  exists now so the retention policy is enforceable the moment scheduling
 *  exists, rather than adding both at once later. Debugging value of a
 *  redacted payload (already PII-free -- see recordWebhookEvent) decays
 *  fast, so a short window is enough. */
export const WEBHOOK_EVENT_RETENTION_DAYS = 30;

export async function purgeOldWebhookEvents(db: Db, olderThan: Date) {
  await db.delete(workosWebhookEvents).where(lt(workosWebhookEvents.receivedAt, olderThan));
}
