import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { courses, users } from "./identity";
import { sections } from "./content";

// ---------- Enums ----------

export const conversationKindEnum = pgEnum("conversation_kind", [
  "section",
  "tutor",
]);

export const messageRoleEnum = pgEnum("message_role", [
  "user",
  "assistant",
  "system",
]);

// ---------- Conversation ----------
// "section" conversations are a student working a specific homework Section;
// "tutor" conversations are the free-standing course-wide tutor (no section).
// The kind/section-nullability pairing is enforced by a CHECK, not just app
// logic. course_id is NOT NULL on both kinds -- it's the tenancy/course-scope
// boundary this table (and messages, via conversation_id) is queried through.
// There is no organization_id column here by design -- conversations scope
// by CourseScope, not OrgScope (see docs/superpowers/plans/2026-08-03-m2-runtime-persistence.md,
// "Resolved Design Decisions" 4/5).

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    sectionId: uuid("section_id").references(() => sections.id, {
      onDelete: "cascade",
    }),
    kind: conversationKindEnum("kind").notNull(),
    title: text("title").notNull(),
    isDeleted: boolean("is_deleted").notNull().default(false),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Matches issue #2's literal (ownerUserId, kind, courseId) column order
    // for the "list this user's tutor conversations" query shape.
    index("conversations_owner_kind_course_idx").on(
      t.ownerUserId,
      t.kind,
      t.courseId,
    ),
    index("conversations_course_kind_idx").on(t.courseId, t.kind),
    // At most one active section-conversation per (user, section). Combined
    // with submissions.conversation_id's own uniqueness (added in #14), this
    // transitively caps submissions at one per (user, section) too --
    // resolves data-model doc §3.5 open question 1.
    uniqueIndex("conversations_owner_section_active_uq")
      .on(t.ownerUserId, t.sectionId)
      .where(sql`${t.kind} = 'section' AND ${t.isDeleted} = false`),
    check(
      "conversations_kind_section_chk",
      sql`(${t.kind} = 'tutor' AND ${t.sectionId} IS NULL)
          OR (${t.kind} = 'section' AND ${t.sectionId} IS NOT NULL)`,
    ),
  ],
);

// ---------- Message ----------
// parts is jsonb matching the AI SDK's UIMessage.parts shape (text parts,
// tool-call parts, etc.). Do not flatten to a plain text column -- tool-call
// / tool-result state would be lost on reload. role stays a narrow enum;
// content-type information already lives per-part in `parts`.

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: messageRoleEnum("role").notNull(),
    parts: jsonb("parts").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("messages_conversation_created_idx").on(
      t.conversationId,
      t.createdAt,
    ),
  ],
);

// ---------- Relations ----------

export const conversationsRelations = relations(
  conversations,
  ({ one, many }) => ({
    owner: one(users, {
      fields: [conversations.ownerUserId],
      references: [users.id],
    }),
    course: one(courses, {
      fields: [conversations.courseId],
      references: [courses.id],
    }),
    section: one(sections, {
      fields: [conversations.sectionId],
      references: [sections.id],
    }),
    messages: many(messages),
  }),
);

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
}));
