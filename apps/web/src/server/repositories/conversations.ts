import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { conversations, messages, sections, homeworks, courseMemberships } from "../../db/schema";
import type { CourseScope } from "./scope";
import { TenancyMismatchError } from "./errors";

export async function listConversationsForOwner(
  db: Db,
  scope: CourseScope,
  ownerUserId: string,
  opts?: { includeDeleted?: boolean; kind?: "section" | "tutor" },
) {
  const conditions = [
    eq(conversations.courseId, scope),
    eq(conversations.ownerUserId, ownerUserId),
  ];
  if (!opts?.includeDeleted) {
    conditions.push(eq(conversations.isDeleted, false));
  }
  // Optional: #5's GET /api/conversations?kind=tutor route always passes
  // this (defaulting to "tutor" itself, not here -- this function stays a
  // no-op filter when omitted so the #3-era repo tests that call it without
  // a kind still see both kinds). desc(updatedAt) matches #5's
  // "ordered by updatedAt desc" requirement -- also harmless for those
  // older tests, none of which assert on ordering.
  if (opts?.kind) {
    conditions.push(eq(conversations.kind, opts.kind));
  }
  const rows = await db
    .select()
    .from(conversations)
    .where(and(...conditions))
    .orderBy(desc(conversations.updatedAt));

  if (rows.length === 0) return [];

  // #4: the tutor-conversations list surface needs a per-conversation
  // message count (its "message-count or preview snippet" requirement --
  // count was chosen over a last-message snippet, see task-4-report.md).
  // A second grouped query rather than a LEFT JOIN + GROUP BY on the
  // primary select above -- same fan-out-avoidance pattern
  // listHomeworksForCourse (homeworks.ts) already uses for sectionCount,
  // merged back in application code via a Map instead of reasoning about
  // duplicate conversation rows a JOIN would produce.
  const counts = await db
    .select({ conversationId: messages.conversationId, count: sql<number>`count(*)::int` })
    .from(messages)
    .where(inArray(messages.conversationId, rows.map((r) => r.id)))
    .groupBy(messages.conversationId);
  const countByConversationId = new Map(counts.map((c) => [c.conversationId, c.count]));

  return rows.map((r) => ({ ...r, messageCount: countByConversationId.get(r.id) ?? 0 }));
}

export async function createConversation(
  db: Db,
  scope: CourseScope,
  input: { ownerUserId: string; sectionId: string | null; kind: "section" | "tutor"; title: string },
) {
  // Neither ownerUserId nor sectionId is guaranteed to belong to `scope`'s
  // course just because the caller says so -- both are caller-supplied
  // UUIDs. Verify membership and section scope before writing, or a
  // mismatched id gets a conversation minted into the wrong course.
  // droppedAt IS NULL matches listMembershipsForUser (#139) -- a dropped
  // membership must not be able to originate new conversations either.
  // Both throws below are TenancyMismatchError (repositories/errors.ts,
  // #141), mapped to an honest 404 by app.onError (server/index.ts) at
  // this function's two real callers -- createConversationHandler
  // (routes/conversations.ts, #5) and chatHandler's new-conversation branch
  // (routes/chat.ts, #3).
  //
  // Reachability today: neither throw is actually hit by either caller as
  // of #141. Both callers mint `scope` via courseScopeFromAuthContext,
  // which already checks input.ownerUserId (always authContext.session.
  // userId, never a different caller-supplied id) against this exact same
  // membership query before this function is even called -- so the
  // membership throw below can only fire via a narrow TOCTOU race (the
  // membership gets dropped between that check and this insert), not a
  // realistic caller mismatch. And both callers always pass
  // `sectionId: null`, so the section throw can never fire at all today.
  // This is defense-in-depth for a future caller that passes a
  // caller-supplied ownerUserId or a non-null sectionId directly (neither
  // does today) -- kept typed and mapped now so that future caller gets
  // the 404 mapping for free, rather than needing its own follow-up issue.
  const [membership] = await db
    .select({ id: courseMemberships.id })
    .from(courseMemberships)
    .where(
      and(
        eq(courseMemberships.userId, input.ownerUserId),
        eq(courseMemberships.courseId, scope),
        isNull(courseMemberships.droppedAt),
      ),
    );
  if (!membership) {
    throw new TenancyMismatchError("Owner is not a member of this course scope");
  }

  if (input.sectionId) {
    const [section] = await db
      .select({ id: sections.id })
      .from(sections)
      .innerJoin(homeworks, eq(sections.homeworkId, homeworks.id))
      .where(and(eq(sections.id, input.sectionId), eq(homeworks.courseId, scope)));
    if (!section) {
      throw new TenancyMismatchError("Section not found in this course scope");
    }
  }

  const [created] = await db
    .insert(conversations)
    .values({ courseId: scope, ...input })
    .returning();
  return created;
}

// Enforces CourseScope only -- any member of the course can soft-delete any
// other student's conversation by UUID, since ownerUserId isn't checked.
// Not yet exploitable (no route calls this), but see ARCHITECTURE.md's "Row
// Ownership (Within a Scope)" section and issue #134: when M3 wires a route
// to this, it should grow a requesterId parameter for that check.
export async function softDeleteConversation(db: Db, scope: CourseScope, conversationId: string) {
  return db
    .update(conversations)
    .set({ isDeleted: true, deletedAt: new Date() })
    .where(and(eq(conversations.id, conversationId), eq(conversations.courseId, scope)));
}

// #5's PATCH /api/conversations/:id (rename). Same CourseScope-only gap as
// softDeleteConversation above -- the route (routes/conversations.ts) does
// the ownerUserId check itself via getConversationById before calling this,
// same pattern chatHandler (#3) established for conversationId ownership,
// rather than this function taking a requesterId. isDeleted is checked so a
// soft-deleted conversation can't be renamed back to life through PATCH;
// the route treats a null return (not found under scope, or soft-deleted)
// as the same 404 as an ownership mismatch.
export async function updateConversationTitle(db: Db, scope: CourseScope, conversationId: string, title: string) {
  const [updated] = await db
    .update(conversations)
    .set({ title })
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.courseId, scope),
        eq(conversations.isDeleted, false),
      ),
    )
    .returning();
  return updated ?? null;
}

// Same CourseScope-only gap as softDeleteConversation above -- see
// ARCHITECTURE.md's "Row Ownership (Within a Scope)" section and #134;
// that gap (no requesterId/ownership check here) is still open and out of
// scope for #141, which only covers the wrong-scope case below. The
// wrong-scope throw is now a TenancyMismatchError (repositories/errors.ts,
// #141), mapped to an honest 404 by app.onError (server/index.ts) rather
// than falling through to the generic 503 -- this function's callers are
// chatHandler's persistence calls (routes/chat.ts, #3). The
// non-transactional check-then-insert is left as-is; not part of #141's
// scope either.
// Also: this never bumps conversations.updatedAt ($onUpdate only fires on
// an UPDATE to the conversations row itself, and appendMessage only
// inserts into messages) -- fine today since nothing reads updatedAt for
// "recently active" ordering yet, but note it here for whenever something
// does (#140).
export async function appendMessage(
  db: Db,
  scope: CourseScope,
  conversationId: string,
  input: { role: "user" | "assistant" | "system"; parts: unknown },
) {
  const [owned] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.courseId, scope),
        eq(conversations.isDeleted, false),
      ),
    );
  if (!owned) {
    throw new TenancyMismatchError("Conversation not found in this course scope");
  }
  const [created] = await db
    .insert(messages)
    .values({ conversationId, role: input.role, parts: input.parts })
    .returning();
  return created;
}

// Unscoped by design (chatHandler needs to look a conversation up by id
// before it knows -- or can prove -- which CourseScope it belongs to). The
// caller MUST check the returned row's ownerUserId against the requesting
// user before trusting it or minting a CourseScope from its courseId (see
// scope.ts's unsafeCourseScope docstring: "a row just read back from the DB
// under an already-verified scope" is the sanctioned case for that cast --
// the ownerUserId check below is what verifies it here).
export async function getConversationById(db: Db, conversationId: string) {
  const [row] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
  return row ?? null;
}

// Used by chatHandler's retry/idempotency check (#3): the most recently
// persisted messages in a conversation, newest first (index 0 = last
// message). limit=2 is what chatHandler needs to distinguish its two retry
// cases -- "the user message already landed but the assistant hasn't
// answered yet" (last row is that same user message) from "the assistant
// already answered but the client never received it" (last row is the
// assistant reply, and the row before it is that same user message) --
// without a second round-trip. Scoped the same way appendMessage is
// (courseId match + not-deleted) so a caller can't probe a message via a
// conversationId scoped to the wrong course.
export async function getLastMessages(db: Db, scope: CourseScope, conversationId: string, limit = 2) {
  const [owned] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.courseId, scope),
        eq(conversations.isDeleted, false),
      ),
    );
  if (!owned) return [];
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(limit);
}

// #4 fix-round: backs GET /api/conversations/:id/messages, added after code
// review caught that selecting an *existing* tutor conversation reset the
// client's useChat message list to empty with no way to reseed it -- not
// just a visual gap, chat.ts's chatHandler builds the model's context
// straight from convertToModelMessages(uiMessages) (the array the CLIENT
// sends), so an empty client-side history meant the LLM silently lost every
// prior turn on resume. Same scoping shape as getLastMessages above
// (courseId match + not-deleted), but ascending by createdAt (oldest
// first) and unlimited -- getLastMessages's newest-first order and small
// limit exist for its own retry-detection purpose (index 0 = last message),
// which is the opposite of what a client needs to seed useChat's initial
// message list in original conversation order. Relies on the same
// `messages_conversation_created_idx` (conversationId, createdAt) index
// getLastMessages already does, so this ordering guarantee isn't new --
// just the other direction over the same index.
export async function getMessagesForConversation(db: Db, scope: CourseScope, conversationId: string) {
  const [owned] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.courseId, scope),
        eq(conversations.isDeleted, false),
      ),
    );
  if (!owned) return [];
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt));
}
