import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { conversations, messages } from "../../db/schema";
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
  const [created] = await db
    .insert(conversations)
    .values({ courseId: scope, ...input })
    .returning();
  return created;
}

export async function softDeleteConversation(db: Db, scope: CourseScope, conversationId: string) {
  return db
    .update(conversations)
    .set({ isDeleted: true, deletedAt: new Date() })
    .where(and(eq(conversations.id, conversationId), eq(conversations.courseId, scope)));
}

export async function appendMessage(
  db: Db,
  scope: CourseScope,
  conversationId: string,
  input: { role: "user" | "assistant" | "system"; parts: unknown },
) {
  const [owned] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.courseId, scope)));
  if (!owned) {
    throw new Error("Conversation not found in this course scope");
  }
  const [created] = await db
    .insert(messages)
    .values({ conversationId, role: input.role, parts: input.parts })
    .returning();
  return created;
}
