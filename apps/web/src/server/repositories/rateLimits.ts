import { lt, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { chatRateLimitWindows } from "../../db/schema";
import { logServerError } from "../utils/errors";

// #219: per-user request budget. A Socratic tutoring turn (or a "create a
// tutor conversation" click, #308) is human-paced, so this is generous, not
// a real throttle -- it exists to bound the cost of a runaway client/script,
// not to shape normal usage. Shared by every caller of reserveRateLimitSlot
// below (originally /api/chat only; #308 added POST /api/conversations)
// rather than each route hand-rolling its own budget, since they're all
// bounding the same failure mode against the same per-user counter table.
export const RATE_LIMIT_MAX_PER_MINUTE = 20;
export const RATE_LIMIT_WINDOW_MS = 60_000;

/* --------------------------------------------------------------------------
   #265: replaces the #219 rate limiter's read-then-decide check (count
   persisted message rows, then rely on a LATER, separate appendMessage call
   as the counted side effect). That shape was a check-then-act race --
   nothing serialized the window between the read and the write three
   round-trips later -- and the counted side effect was skippable on a path
   that still called the model (the idempotency-replay-skip branch), so once
   a provider started throttling, every retry became an uncounted upstream
   call.

   This is a single atomic statement instead: INSERT ... ON CONFLICT DO
   UPDATE ... RETURNING count. Postgres resolves the (userId, windowStart)
   conflict atomically per row, so two concurrent callers can never both
   observe a pre-increment count -- one always sees the other's increment
   already applied. Fixed-window (bucketed by windowStart), not sliding,
   which is what makes one statement sufficient: a sliding window needs a
   read to size the write.
   -------------------------------------------------------------------------- */

/** #317 review, #326: this table has no cleanup path anywhere -- one row
 *  per user per active minute, unbounded (issue #313 estimated ~600K
 *  rows/cohort/term). PR4's real scheduled-job infra
 *  (`apps/web/src/server/jobs/`) doesn't exist yet, so rather than wait on
 *  that, this is a lightweight best-effort purge run probabilistically
 *  from inside reserveRateLimitSlot itself -- same "no dedicated
 *  infrastructure needed yet" posture as webhookEvents.ts's
 *  purgeOldWebhookEvents, just triggered inline instead of by a caller.
 *  A window is only ever read/written by ITS OWN bucket
 *  (`Math.floor(now/windowMs)*windowMs`), so a row is dead the moment
 *  `now` moves past its bucket -- one retention window of slack is pure
 *  safety margin, not a real requirement. */
const RATE_LIMIT_RETENTION_MS = 24 * 60 * 60 * 1000;
// Expected value: one purge DELETE per ~100 reservations -- amortizes to
// near-zero average added latency (this function is on the hot path of
// every chat turn) while still bounding how long the table can grow
// between purges. Not a cron-precise guarantee; "best-effort" per this
// function's own doc comment above.
const PURGE_PROBABILITY = 0.01;

/** Atomically increments this user's counter for the window containing
 *  `now` and returns the post-increment count. Call unconditionally, before
 *  any other work -- the whole point is that every request that reaches
 *  this point counts, not just ones that happen to reach a later
 *  persistence call. */
export async function reserveRateLimitSlot(
  db: Db,
  userId: string,
  now: Date,
  windowMs: number,
): Promise<number> {
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const [row] = await db
    .insert(chatRateLimitWindows)
    .values({ userId, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: [chatRateLimitWindows.userId, chatRateLimitWindows.windowStart],
      set: { count: sql`${chatRateLimitWindows.count} + 1` },
    })
    .returning({ count: chatRateLimitWindows.count });

  // #317 review, code-review follow-up: this call runs unconditionally on
  // the hot path of every chat turn and every conversation creation --
  // NOT awaited, so the ~1% of requests that trigger the purge don't wait
  // on a DELETE behind the reservation they actually asked for. A dropped
  // purge attempt (this function returning, and on Cloudflare Workers
  // potentially the whole invocation ending, before the DELETE lands) is
  // harmless: it costs nothing but one skipped opportunity, and the next
  // ~100th call gets another. See RATE_LIMIT_WINDOW_IDX (schema/runtime.ts)
  // for the other half of this fix -- the DELETE's own WHERE clause had no
  // supporting index.
  if (Math.random() < PURGE_PROBABILITY) {
    db.delete(chatRateLimitWindows)
      .where(lt(chatRateLimitWindows.windowStart, new Date(now.getTime() - RATE_LIMIT_RETENTION_MS)))
      .catch((err) => {
        logServerError("reserveRateLimitSlot.purge", err);
      });
  }

  return row!.count;
}
