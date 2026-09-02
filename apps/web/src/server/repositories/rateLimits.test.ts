import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { makeNodeDb } from "../../db/nodeClient";
import type { Db } from "../../db/client";
import { users, chatRateLimitWindows, organizations, courses, conversations, messages } from "../../db/schema";
import { reserveRateLimitSlot, retryAfterSeconds } from "./rateLimits";

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

  // #317 review, #326: reserveRateLimitSlot's own best-effort purge --
  // Math.random is stubbed so the probabilistic trigger is deterministic in
  // a test, matching the pattern this doc comment on the purge itself
  // describes ("expected value" behavior, verified here as a hard branch).
  describe("best-effort purge (#326)", () => {
    // #317 review, code-review follow-up: the purge is no longer awaited
    // inline (fire-and-forget, so the ~1% of calls that trigger it don't
    // block the reservation the caller actually asked for -- see the
    // purge's own doc comment in rateLimits.ts), so its effect is no longer
    // guaranteed visible the instant reserveRateLimitSlot resolves. Polls
    // for the delete to land instead of asserting it happened synchronously.
    it("deletes windows older than the retention period when the purge triggers", async () => {
      const staleWindowStart = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      await db.insert(chatRateLimitWindows).values({ userId, windowStart: staleWindowStart, count: 1 });

      const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
      try {
        await reserveRateLimitSlot(db, userId, testWindow(5), windowMs);
      } finally {
        randomSpy.mockRestore();
      }

      const readStale = () =>
        db
          .select()
          .from(chatRateLimitWindows)
          .where(and(eq(chatRateLimitWindows.userId, userId), eq(chatRateLimitWindows.windowStart, staleWindowStart)));
      let stale = await readStale();
      const deadline = Date.now() + 5_000;
      while (stale.length > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        stale = await readStale();
      }
      expect(stale[0]).toBeUndefined();
    });

    it("leaves old windows alone when the purge does not trigger", async () => {
      const staleWindowStart = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      await db.insert(chatRateLimitWindows).values({ userId, windowStart: staleWindowStart, count: 1 });

      const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.99);
      try {
        await reserveRateLimitSlot(db, userId, testWindow(6), windowMs);
      } finally {
        randomSpy.mockRestore();
      }

      const [stale] = await db
        .select()
        .from(chatRateLimitWindows)
        .where(and(eq(chatRateLimitWindows.userId, userId), eq(chatRateLimitWindows.windowStart, staleWindowStart)));
      expect(stale).toBeDefined();

      await db.delete(chatRateLimitWindows).where(eq(chatRateLimitWindows.windowStart, staleWindowStart));
    });

    it("does not delete a window inside the retention period even when the purge triggers", async () => {
      const now = testWindow(7);
      await reserveRateLimitSlot(db, userId, now, windowMs);

      const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
      try {
        await reserveRateLimitSlot(db, userId, now, windowMs);
      } finally {
        randomSpy.mockRestore();
      }

      const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
      const [row] = await db
        .select({ count: chatRateLimitWindows.count })
        .from(chatRateLimitWindows)
        .where(and(eq(chatRateLimitWindows.userId, userId), eq(chatRateLimitWindows.windowStart, windowStart)));
      expect(row?.count).toBe(2);
    });
  });

  // #308 (requirement 5, as filed): the issue's evidence was
  // `countRecentUserMessagesForUser`, a function that read a COUNT of
  // persisted message rows and did not filter `conversations.isDeleted` --
  // so messages sitting in a conversation the student had soft-deleted still
  // inflated their live budget. That function no longer exists anywhere in
  // this codebase (#265 replaced it, predating this dispatch): the current
  // counter is `chatRateLimitWindows`, an atomic per-(userId, windowStart)
  // upsert that never queries `conversations` or `messages` at all -- see
  // reserveRateLimitSlot's own signature above, which takes no
  // conversationId and joins nothing. This test encodes the exact scenario
  // the issue feared (a pile of messages sitting in a deleted conversation
  // for this user) and proves it has zero effect on the counter, as a
  // regression guard against a future rate limiter that goes back to
  // scanning messages/conversations without an isDeleted filter.
  it("#308: messages in a deleted conversation do not inflate the rate-limit counter", async () => {
    const [org] = await db
      .insert(organizations)
      .values({ slug: `ratelimit-${crypto.randomUUID()}`, name: "RL Org", workosOrganizationId: `w-rl-${crypto.randomUUID()}` })
      .returning({ id: organizations.id });
    const [course] = await db
      .insert(courses)
      .values({ organizationId: org!.id, code: "C", term: "T", title: "T" })
      .returning({ id: courses.id });
    const [deletedConvo] = await db
      .insert(conversations)
      .values({
        ownerUserId: userId,
        courseId: course!.id,
        sectionId: null,
        kind: "tutor",
        title: "deleted before this test asserts anything",
        isDeleted: true,
        deletedAt: new Date(),
      })
      .returning({ id: conversations.id });

    // A pile of messages -- comfortably more than RATE_LIMIT_MAX_PER_MINUTE
    // would allow as live requests -- sitting in that deleted conversation.
    // If any rate limiter ever counted these, this user's very first real
    // request afterward would already read as throttled.
    await db.insert(messages).values(
      Array.from({ length: 30 }, (_, i) => ({
        conversationId: deletedConvo!.id,
        role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        parts: [{ type: "text", text: `message ${i}` }],
        clientMessageId: i % 2 === 0 ? crypto.randomUUID() : null,
      })),
    );

    const count = await reserveRateLimitSlot(db, userId, testWindow(8), windowMs);
    expect(count).toBe(1);
  });
});

/* #310 review: the header the client now gates its Retry button on.

   Needs no database -- it is pure arithmetic over the same bucketing
   reserveRateLimitSlot uses, and the whole point is that the two agree. */
describe("retryAfterSeconds (#310 review)", () => {
  const WINDOW = 60_000;

  it("reports the time left in THIS window, not the window's length", () => {
    // The case that motivated it: refused half a second before the boundary.
    // The old header said 60, so a client honouring it waited ~59s longer
    // than the limiter actually required.
    expect(retryAfterSeconds(new Date(120_000 + 59_500), WINDOW)).toBe(1);
    // Refused at the very start of a window: nearly the whole window left.
    expect(retryAfterSeconds(new Date(120_000), WINDOW)).toBe(60);
    // Halfway through.
    expect(retryAfterSeconds(new Date(120_000 + 30_000), WINDOW)).toBe(30);
  });

  it("never reports zero for a request that was just refused", () => {
    // A sub-second remainder must not floor to 0 -- that would tell the
    // client there is nothing to wait for on a turn the server just refused.
    expect(retryAfterSeconds(new Date(120_000 + 59_999), WINDOW)).toBe(1);
  });

  it("agrees with reserveRateLimitSlot's own bucketing", () => {
    // Both derive the window from Math.floor(now/windowMs)*windowMs. Two
    // timestamps in the same bucket must count down to the same instant.
    const a = retryAfterSeconds(new Date(180_000 + 10_000), WINDOW);
    const b = retryAfterSeconds(new Date(180_000 + 40_000), WINDOW);
    expect(a - b).toBe(30);
  });
});
