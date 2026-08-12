import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { makeNodeDb } from "../../db/nodeClient";
import type { Db } from "../../db/client";
import { users, chatRateLimitWindows } from "../../db/schema";
import { reserveRateLimitSlot } from "./rateLimits";

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)("reserveRateLimitSlot (#265, real DB)", () => {
  let db: Db;
  let userId: string;

  beforeAll(async () => {
    db = makeNodeDb(DATABASE_URL!);
    const emailBytes = crypto.getRandomValues(new Uint8Array(32));
    const [user] = await db
      .insert(users)
      .values({ email: emailBytes as never, emailBlindIndex: emailBytes as never })
      .returning({ id: users.id });
    userId = user!.id;
  });

  afterAll(async () => {
    await db.delete(users).where(eq(users.id, userId));
  });

  // Every test below picks its own timestamp far away (many windowMs
  // multiples) from the others -- all tests share `userId`, and windows
  // are bucketed by wall-clock time, so two tests landing in the same real
  // minute would otherwise silently share a row and pollute each other's
  // counts. This is a test-isolation concern only; reserveRateLimitSlot
  // itself has no notion of "test."
  const windowMs = 60_000;
  const testWindow = (offsetWindows: number) => new Date(Date.now() + offsetWindows * windowMs * 100);

  it("returns 1 on the first call in a window, then increments sequentially for later calls in the same window", async () => {
    const now = testWindow(1);
    const a = await reserveRateLimitSlot(db, userId, now, windowMs);
    const b = await reserveRateLimitSlot(db, userId, now, windowMs);
    const c = await reserveRateLimitSlot(db, userId, now, windowMs);
    expect([a, b, c]).toEqual([1, 2, 3]);
  });

  it("starts a fresh count of 1 in a different window (does not leak across windows)", async () => {
    const now = testWindow(2);
    await reserveRateLimitSlot(db, userId, now, windowMs);
    await reserveRateLimitSlot(db, userId, now, windowMs);

    // A timestamp guaranteed to bucket into a later, distinct window.
    const nextWindow = new Date(Math.floor(now.getTime() / windowMs) * windowMs + windowMs + 1);
    const count = await reserveRateLimitSlot(db, userId, nextWindow, windowMs);
    expect(count).toBe(1);
  });

  it("does not leak across users -- a different user's count starts at 1 independently", async () => {
    const emailBytes = crypto.getRandomValues(new Uint8Array(32));
    const [otherUser] = await db
      .insert(users)
      .values({ email: emailBytes as never, emailBlindIndex: emailBytes as never })
      .returning({ id: users.id });
    const otherUserId = otherUser!.id;

    const now = testWindow(3);
    await reserveRateLimitSlot(db, userId, now, windowMs);
    await reserveRateLimitSlot(db, userId, now, windowMs);
    const otherCount = await reserveRateLimitSlot(db, otherUserId, now, windowMs);

    expect(otherCount).toBe(1);
    await db.delete(users).where(eq(users.id, otherUserId));
  });

  // #265's own concurrency requirement: N parallel requests must yield at
  // most the limit's worth of "allowed" outcomes -- proving the atomic
  // upsert actually serializes concurrent callers targeting the same
  // (userId, windowStart) row, rather than every caller reading the same
  // pre-increment count (the race the old countRecentUserMessagesForUser
  // check was vulnerable to).
  it("under real concurrency, N parallel calls for the same user+window produce the sequence 1..N with no duplicates or gaps", async () => {
    const now = testWindow(4);
    const N = 25;

    const counts = await Promise.all(
      Array.from({ length: N }, () => reserveRateLimitSlot(db, userId, now, windowMs)),
    );

    const sorted = [...counts].sort((a, b) => a - b);
    expect(sorted).toEqual(Array.from({ length: N }, (_, i) => i + 1));

    const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
    const [row] = await db
      .select({ count: chatRateLimitWindows.count })
      .from(chatRateLimitWindows)
      .where(and(eq(chatRateLimitWindows.userId, userId), eq(chatRateLimitWindows.windowStart, windowStart)));
    expect(row?.count).toBe(N);
  });
});
