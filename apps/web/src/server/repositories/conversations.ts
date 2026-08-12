import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../../db/client";
import { conversations, messages, sections, homeworks, courseMemberships, submissions } from "../../db/schema";
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
//
// #128: refuses a conversation that already has a submission. Soft-deleting
// one here would leave the submission row alive, pointing at a conversation
// the student can no longer see -- and the moment they start a replacement
// and submit it, a second submissions row for the same section. Callers that
// mean "start over" want restartSectionConversation (repositories/
// submissions.ts), which voids the submission in the same atomic group.
// Tutor conversations can never have a submission (the composite FK added in
// #128 makes that structural), so they are unaffected by this check.
export async function softDeleteConversation(db: Db, scope: CourseScope, conversationId: string) {
  const [blocking] = await db
    .select({ id: submissions.id })
    .from(submissions)
    .innerJoin(conversations, eq(submissions.conversationId, conversations.id))
    .where(and(eq(conversations.id, conversationId), eq(conversations.courseId, scope)));
  if (blocking) {
    throw new Error(
      "Conversation has a submission; use restartSectionConversation to void it (#128)",
    );
  }

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
