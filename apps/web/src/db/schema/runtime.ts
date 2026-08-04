import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { courseMemberships, courses, organizations, users } from "./identity";
import { materialChunks, sections } from "./content";

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

// ---------- Submission ----------
// 1:1 with a conversation. organization_id is denormalized per the epic's
// cross-cutting invariant (submissions is in the required-org-id list).
// No separate created_at -- a submission row's existence is the submit
// event (matches Django's auto_now_add behavior); a separate created_at
// would always equal submitted_at and add nothing.

export const submissions = pgTable(
  "submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .unique()
      .references(() => conversations.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    submittedAt: timestamp("submitted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("submissions_org_idx").on(t.organizationId)],
);

// ---------- Grade ----------
// N:1 from submission (AI-first, instructor override allowed as a second
// row). CHECK enforces exactly one of (graded_by_ai, grader_membership_id
// set) -- an AI grade can never carry a human grader FK and vice versa.

export const grades = pgTable(
  "grades",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => submissions.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    graderMembershipId: uuid("grader_membership_id").references(
      () => courseMemberships.id,
      { onDelete: "set null" },
    ),
    gradedByAi: boolean("graded_by_ai").notNull().default(false),
    score: doublePrecision("score"),
    rubric: jsonb("rubric"),
    feedback: text("feedback"),
    gradedAt: timestamp("graded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("grades_org_idx").on(t.organizationId),
    index("grades_submission_idx").on(t.submissionId),
    check(
      "grades_grader_consistency_chk",
      sql`(${t.gradedByAi} = true AND ${t.graderMembershipId} IS NULL)
          OR (${t.gradedByAi} = false AND ${t.graderMembershipId} IS NOT NULL)`,
    ),
  ],
);

// ---------- Citation ----------
// Polymorphic source: exactly one of (message_id, grade_id) is non-null,
// same num_nonnulls() pattern as content.ts's promptTemplates.

export const citations = pgTable(
  "citations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id").references(() => messages.id, {
      onDelete: "cascade",
    }),
    gradeId: uuid("grade_id").references(() => grades.id, {
      onDelete: "cascade",
    }),
    materialChunkId: uuid("material_chunk_id")
      .notNull()
      .references(() => materialChunks.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    spanStart: integer("span_start"),
    spanEnd: integer("span_end"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("citations_org_idx").on(t.organizationId),
    index("citations_material_chunk_idx").on(t.materialChunkId),
    check(
      "citations_single_source_chk",
      sql`num_nonnulls(${t.messageId}, ${t.gradeId}) = 1`,
    ),
  ],
);

// ---------- Relations ----------

export const submissionsRelations = relations(submissions, ({ one, many }) => ({
  conversation: one(conversations, {
    fields: [submissions.conversationId],
    references: [conversations.id],
  }),
  organization: one(organizations, {
    fields: [submissions.organizationId],
    references: [organizations.id],
  }),
  grades: many(grades),
}));

export const gradesRelations = relations(grades, ({ one, many }) => ({
  submission: one(submissions, {
    fields: [grades.submissionId],
    references: [submissions.id],
  }),
  grader: one(courseMemberships, {
    fields: [grades.graderMembershipId],
    references: [courseMemberships.id],
  }),
  citations: many(citations),
}));

export const citationsRelations = relations(citations, ({ one }) => ({
  message: one(messages, {
    fields: [citations.messageId],
    references: [messages.id],
  }),
  grade: one(grades, {
    fields: [citations.gradeId],
    references: [grades.id],
  }),
  materialChunk: one(materialChunks, {
    fields: [citations.materialChunkId],
    references: [materialChunks.id],
  }),
}));
