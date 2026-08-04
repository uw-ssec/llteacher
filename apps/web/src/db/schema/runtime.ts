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
import { llmConfigs, llmProviderEnum, materialChunks, sections } from "./content";

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

// ---------- LLMCallLog ----------
// 1:1 per message. conversation_id is denormalized (reachable via
// message -> conversation, but the M8 analytics query shape is
// "calls by conversation" and "calls by org+time" -- avoid a join for both).

export const llmCallLogs = pgTable(
  "llm_call_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id")
      .notNull()
      .unique()
      .references(() => messages.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    llmConfigId: uuid("llm_config_id").references(() => llmConfigs.id, {
      onDelete: "set null",
    }),
    provider: llmProviderEnum("provider").notNull(),
    model: text("model").notNull(),
    providerRequestId: text("provider_request_id"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costCents: integer("cost_cents"),
    latencyMs: integer("latency_ms"),
    errorFlag: boolean("error_flag").notNull().default(false),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("llm_call_logs_org_time_idx").on(t.organizationId, t.occurredAt),
    index("llm_call_logs_conversation_idx").on(t.conversationId),
  ],
);

// ---------- StudentProfile ----------
// Derived/regenerable state, NOT authoritative -- safe to truncate and
// rebuild from raw conversations. See docs/architecture/multi-tenant-data-model.md
// §3.2 StudentProfile. computed_at is null until the first computation job runs.

export const studentProfiles = pgTable(
  "student_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    summary: text("summary"),
    masterySignals: jsonb("mastery_signals"),
    computedAt: timestamp("computed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("student_profiles_user_course_uq").on(t.userId, t.courseId),
    index("student_profiles_org_idx").on(t.organizationId),
  ],
);

// ---------- AuditEvent ----------
// Append-only. No update/delete function exists for this table anywhere in
// the repository layer (repositories/auditEvents.ts exports only
// recordAuditEvent) -- that is the M2 enforcement mechanism. DB-level
// REVOKE UPDATE, DELETE grants need a dedicated low-privilege app role and
// are tracked as follow-up infra work, not part of this migration.

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: uuid("target_id").notNull(),
    ip: text("ip"),
    requestMetadata: jsonb("request_metadata"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("audit_events_org_time_idx").on(t.organizationId, t.occurredAt),
    index("audit_events_actor_time_idx").on(t.actorUserId, t.occurredAt),
    index("audit_events_target_idx").on(t.targetType, t.targetId),
  ],
);

// ---------- Relations ----------

export const llmCallLogsRelations = relations(llmCallLogs, ({ one }) => ({
  message: one(messages, {
    fields: [llmCallLogs.messageId],
    references: [messages.id],
  }),
  conversation: one(conversations, {
    fields: [llmCallLogs.conversationId],
    references: [conversations.id],
  }),
  organization: one(organizations, {
    fields: [llmCallLogs.organizationId],
    references: [organizations.id],
  }),
  llmConfig: one(llmConfigs, {
    fields: [llmCallLogs.llmConfigId],
    references: [llmConfigs.id],
  }),
}));

export const studentProfilesRelations = relations(studentProfiles, ({ one }) => ({
  user: one(users, {
    fields: [studentProfiles.userId],
    references: [users.id],
  }),
  course: one(courses, {
    fields: [studentProfiles.courseId],
    references: [courses.id],
  }),
}));

export const auditEventsRelations = relations(auditEvents, ({ one }) => ({
  organization: one(organizations, {
    fields: [auditEvents.organizationId],
    references: [organizations.id],
  }),
  actor: one(users, {
    fields: [auditEvents.actorUserId],
    references: [users.id],
  }),
}));
