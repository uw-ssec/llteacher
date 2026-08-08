import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "../../db/client";
import { conversations, messages, sections, homeworks, courseMemberships } from "../../db/schema";
import type { CourseScope } from "./scope";

export async function listConversationsForOwner(
  db: Db,
  scope: CourseScope,
  ownerUserId: string,
  opts?: { includeDeleted?: boolean },
) {
  const conditions = [
    eq(conversations.courseId, scope),
    eq(conversations.ownerUserId, ownerUserId),
  ];
  if (!opts?.includeDeleted) {
    conditions.push(eq(conversations.isDeleted, false));
  }
  return db.select().from(conversations).where(and(...conditions));
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
  // Both throws below are plain Error, not yet a typed not-found error
  // mapped to 404 at the route layer -- tracked in #141, to land when #5
  // wires a real route to this function.
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
    throw new Error("Owner is not a member of this course scope");
  }

  if (input.sectionId) {
    const [section] = await db
      .select({ id: sections.id })
      .from(sections)
      .innerJoin(homeworks, eq(sections.homeworkId, homeworks.id))
      .where(and(eq(sections.id, input.sectionId), eq(homeworks.courseId, scope)));
    if (!section) {
      throw new Error("Section not found in this course scope");
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

// Same CourseScope-only gap as softDeleteConversation above -- see
// ARCHITECTURE.md's "Row Ownership (Within a Scope)" section and #134.
// The wrong-scope Error here (generic 503 once a route wires this up, vs.
// the more honest 404 -- tracked in #141) and the non-transactional
// check-then-insert are left as-is for now -- all three get tightened
// together with the ownership work when #134/#141 land, not as a
// standalone fix now.
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
    throw new Error("Conversation not found in this course scope");
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
