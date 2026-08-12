import { sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { chatRateLimitWindows } from "../../db/schema";

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
  return row!.count;
}
