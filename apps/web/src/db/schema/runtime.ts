import { relations, sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { courseMemberships, courses, organizations, users } from "./identity";
import {
  llmConfigs,
  llmProviderEnum,
  materialChunks,
  sections,
  homeworkProgressWidgets,
  promptTemplates,
  hintActionEnum,
} from "./content";

// ---------- Enums ----------

export const conversationKindEnum = pgEnum("conversation_kind", [
  "section",
  "tutor",
]);

// #308: the single source of truth for the app-code union -- every route/
// repository/shared-types file that used to hand-write `"section" | "tutor"`
// derives it from here instead, so adding a third enum value can't silently
// leave one of those literal unions stale (TypeScript would flag every
// switch/conditional that assumed exhaustiveness the moment the enum grows).
export type ConversationKind = (typeof conversationKindEnum.enumValues)[number];

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
    // #27: an instructor working a section to try out their own prompt, as
    // opposed to a student doing the assignment. Django derived this at read
    // time (`hasattr(user, 'teacher_profile')`); stored here instead because
    // a derived check is retroactive -- promote a student to TA and every
    // conversation they ever had silently becomes a "teacher test". What was
    // true when the conversation started is the thing being recorded.
    //
    // Deliberately NOT the `conversation_type` enum #27's text points at.
    // docs/architecture/multi-tenant-data-model.md's `conversation_type` is
    // `recall | discovery | critical_thinking | tutor | evaluator` -- a
    // pedagogical mode, an unrelated concept that isn't being built here, and
    // taking that name now would collide when it is. That same doc says
    // is_teacher_test should "collapse into a CourseMembership.role check",
    // which is what this column deliberately does not do, for the reason
    // above. Also avoids a second "type"-shaped column beside `kind`.
    isTeacherTest: boolean("is_teacher_test").notNull().default(false),
    // #25: pinned once at conversation creation (resolvePromptTemplate,
    // lib/prompts.ts) and never re-resolved per-message -- a mid-conversation
    // template edit must not flip which version this conversation's system
    // prompt uses (the cross-cutting invariant #30 lists for this epic).
    // Nullable: a template row pins an exact version already (each edit is a
    // new row via previousVersionId), so no separate version column is
    // needed; null means resolution fell through to the built-in fallback
    // constant (DEFAULT_SYSTEM_PROMPT) rather than a real template row, or
    // the conversation predates this column.
    promptTemplateId: uuid("prompt_template_id").references(() => promptTemplates.id, {
      onDelete: "set null",
    }),
    isDeleted: boolean("is_deleted").notNull().default(false),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    // #317 review, #322: a per-conversation turn lock -- set (via a
    // conditional UPDATE, see acquireConversationTurnLock in
    // repositories/conversations.ts) the moment a turn starts processing,
    // cleared when it finishes. Two concurrent sends on one conversation
    // (two tabs, a double-fired send) used to interleave into
    // Q_a, Q_b, A_a, A_b with no ordering guarantee, and a lost-response
    // retry could permanently 409 even though the real answer was already
    // persisted (classifyTurn's replay path only ever inspects the last two
    // rows). Nullable: null means no turn is in flight. A lock older than
    // LOCK_STALE_MS (chat.ts) is treated as abandoned (a Worker killed
    // mid-request never clears it) rather than a permanent deadlock.
    processingStartedAt: timestamp("processing_started_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
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
    // #281: listConversationsForOwner's ORDER BY updated_at DESC (the
    // tutor-rail list, #5/#224) had no index serving that sort --
    // conversations_owner_kind_course_idx above satisfies the equality
    // predicates (owner_user_id, kind, course_id) but Postgres still had to
    // sort every matching row before applying LIMIT. This index makes the
    // sort itself index-served; id isn't part of the index (the compound
    // cursor's tiebreaker is resolved by an equality condition on
    // updated_at within the already-narrow index range, not by a second
    // sort column here).
    index("conversations_owner_kind_updated_idx").on(
      t.ownerUserId,
      t.kind,
      t.updatedAt,
    ),
    // #29: same reasoning as conversations_owner_kind_updated_idx directly
    // above, for the instructor transcript list's default (unfiltered)
    // query -- listInstructorTranscripts (repositories/sectionConversations.ts)
    // orders by updated_at DESC within (courseId, kind='section').
    // conversations_course_kind_idx already serves the equality predicates;
    // without this, Postgres still sorted every matching row in the course
    // before applying LIMIT/OFFSET. The two optional list filters
    // (sectionId, studentId) are already served by conversations_section_idx
    // and conversations_owner_kind_course_idx respectively -- this index is
    // only for the common unfiltered case, matching #281's own scope
    // decision not to index every filter combination up front.
    index("conversations_course_kind_updated_idx").on(
      t.courseId,
      t.kind,
      t.updatedAt,
    ),
    // conversations_owner_section_active_uq (below) leads with owner_user_id,
    // so it can't serve "all conversations on this section" (instructor
    // roster views) or the section-delete cascade -- both need section_id
    // leading. Found in PR #127 review, #135.
    index("conversations_section_idx").on(t.sectionId),
    // #317 review, #326: prompt_template_id's own onDelete: "set null" write
    // (a template row being deleted) had no index to serve it -- an
    // unindexed FK forces a full table scan of `conversations` to find every
    // row pointing at the id being deleted, on every such delete.
    index("conversations_prompt_template_idx").on(t.promptTemplateId),
    // At most one active section-conversation per (user, section) -- the
    // active-conversation case only, not a transitive cap on submissions
    // per (user, section): a soft-delete-and-recreate cycle can still
    // accumulate more than one `submissions` row for the same section. See
    // #128 for that gap and why it's deliberately unresolved in M2.
    uniqueIndex("conversations_owner_section_active_uq")
      .on(t.ownerUserId, t.sectionId)
      .where(sql`${t.kind} = 'section' AND ${t.isDeleted} = false`),
    // #308: restated as two independent implications instead of an
    // exhaustive OR of every (kind, section_id) pair -- the OR form only
    // has two disjuncts because there are only two kinds today, so it
    // silently double-duties as an allowlist of kind itself: a future third
    // kind value (e.g. one #27's own doc comment above gestures at) would
    // satisfy neither disjunct and be rejected by this CHECK no matter what
    // section_id it carried, forcing a rewrite of this constraint (not just
    // an addition) the moment conversationKindEnum grows. Each implication
    // below only constrains the kind it names -- "if this row claims to be
    // a tutor conversation, section_id must be null" / "...a section
    // conversation, section_id must be set" -- and says nothing at all
    // about a third kind, so adding one only means adding its own
    // implication (or leaving it unconstrained here) instead of restating
    // the whole thing.
    check(
      "conversations_kind_section_chk",
      sql`(${t.kind} <> 'tutor' OR ${t.sectionId} IS NULL)
          AND (${t.kind} <> 'section' OR ${t.sectionId} IS NOT NULL)`,
    ),
    // #128: referenceable target for submissions' composite FK. `id` is
    // already the primary key, so this adds no new integrity rule to
    // conversations -- it exists solely because Postgres will only accept a
    // foreign key whose referenced columns carry a unique constraint of
    // exactly that shape.
    unique("conversations_id_owner_section_uq").on(t.id, t.ownerUserId, t.sectionId),
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
    // #213: the AI SDK's own per-send UIMessage.id, persisted for user rows
    // so a retry (same id, resent) can be told apart from a genuinely new
    // message with identical text (new id) -- chatHandler's idempotency
    // check keys off this instead of JSON.stringify(parts) equality. Null
    // for assistant/system rows (server-authored, no client id to record);
    // Postgres unique indexes treat NULL as distinct from every other NULL,
    // so those rows never collide against each other or against a real id.
    clientMessageId: text("client_message_id"),
    // #221: monotonic tiebreaker for ordering. createdAt alone is
    // timestamptz (microsecond resolution) -- safe today only because each
    // append is its own transaction, so two rows can never share a
    // timestamp; stops being safe the moment appends are ever batched.
    // Global (not per-conversation) bigserial, per the issue's own
    // suggestion -- ordering only ever needs to be correct within one
    // conversation's rows, and a global sequence guarantees that trivially.
    seq: bigserial("seq", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("messages_conversation_created_idx").on(
      t.conversationId,
      t.createdAt,
    ),
    index("messages_conversation_seq_idx").on(t.conversationId, t.seq),
    uniqueIndex("messages_conversation_client_message_id_idx").on(
      t.conversationId,
      t.clientMessageId,
    ),
  ],
);

// #265: fixed-window per-user rate limit counter for /api/chat. A FIXED
// window (bucketed by windowStart), not a sliding one, is what lets the
// whole check-and-increment happen as one atomic upsert -- a sliding
// window (count rows created in the last N ms) needs a read before the
// write can be sized, which is exactly the check-then-act race this table
// replaces (countRecentUserMessagesForUser counted persisted message rows,
// with the actual increment three round-trips later and nothing
// serializing the window in between). windowStart is computed by the
// caller as floor(now / windowMs) * windowMs.
export const chatRateLimitWindows = pgTable(
  "chat_rate_limit_windows",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [
    uniqueIndex("chat_rate_limit_windows_user_window_idx").on(
      t.userId,
      t.windowStart,
    ),
    // #317 review, code-review follow-up: reserveRateLimitSlot's own purge
    // (repositories/rateLimits.ts) deletes `WHERE window_start < cutoff` --
    // the unique index above leads with user_id, so it can't serve that
    // predicate; without this, the purge was a full table scan of a table
    // #313 itself estimated at ~600K rows/cohort/term.
    index("chat_rate_limit_windows_window_start_idx").on(t.windowStart),
  ],
);

// ---------- HintEvent ----------
// #80: one row per explicit "give me a hint" request the server actually
// granted (see hintBudgets, content.ts, for the optional per-section cap
// checked before a row is written here) -- an append-only event log, unlike
// hintBudgets' config-like lifecycle, which is why this lives in runtime.ts
// alongside messages/auditEvents/llmCallLogs rather than content.ts.
//
// Deterministic and countable by construction: a row exists if and only if
// a hint was granted. Never inferred by classifying the tutor's free-text
// reply after the fact -- the issue's own explicitly-rejected alternative
// (fragile; a Socratic tutor's ordinary leading question is not
// distinguishable from a "hint" by text alone).
//
// Scoped to (section_id, student_id) for the usage count this task's
// budget check reads (getHintCount, repositories/hints.ts) -- per this
// task's ruling (see the PR report): a shared per-section pool would let
// one student's hint use exhaust the budget for the whole class, and
// nothing else in this schema's per-student state (submissions,
// section_answers, homework_progress_widget_responses) shares state across
// students that way. organization_id is denormalized for the same
// FERPA-export/direct-predicate reasons those tables already carry it.
export const hintEvents = pgTable(
  "hint_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    sectionId: uuid("section_id")
      .notNull()
      .references(() => sections.id, { onDelete: "cascade" }),
    studentId: uuid("student_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    action: hintActionEnum("action").notNull().default("request_hint"),
    // Read-model convenience: whether THIS request pushed the student's
    // (section, student) usage to (or past) the section's configured
    // maxHints, computed once at insert time (recordHintRequest,
    // repositories/hints.ts) rather than re-derived from a count query on
    // every read. Always false when the section has no configured limit.
    isLimitReached: boolean("is_limit_reached").notNull().default(false),
    // The issue's own sketch's "promptTemplateVersionUsed" -- the
    // conversation's pinned prompt_templates row (conversations.
    // promptTemplateId, #25/#30) at the moment this hint was granted, so a
    // later template edit can't retroactively change what a past hint
    // event appears to have been scaffolded against. Nullable: null means
    // the conversation had no pinned template yet (DEFAULT_SYSTEM_PROMPT
    // was in effect, lib/prompts.ts).
    promptTemplateId: uuid("prompt_template_id").references(() => promptTemplates.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // getHintCount's own query shape (repositories/hints.ts): COUNT(*)
    // WHERE section_id = ? AND student_id = ?.
    index("hint_events_section_student_idx").on(t.sectionId, t.studentId),
    // recordHintRequest's idempotency-window lookup: the most recent event
    // for a given (conversation, student), ordered by created_at.
    index("hint_events_conversation_student_created_idx").on(
      t.conversationId,
      t.studentId,
      t.createdAt,
    ),
    index("hint_events_org_idx").on(t.organizationId),
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

export const hintEventsRelations = relations(hintEvents, ({ one }) => ({
  conversation: one(conversations, {
    fields: [hintEvents.conversationId],
    references: [conversations.id],
  }),
  section: one(sections, {
    fields: [hintEvents.sectionId],
    references: [sections.id],
  }),
  student: one(users, {
    fields: [hintEvents.studentId],
    references: [users.id],
  }),
  organization: one(organizations, {
    fields: [hintEvents.organizationId],
    references: [organizations.id],
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
    // #128: denormalized from the owning conversation so that "one submission
    // per (student, section)" becomes expressible at all. submissions
    // previously carried neither column, which is why the
    // soft-delete-and-recreate cycle could accumulate rows with nothing to
    // detect it: UNIQUE(conversation_id) only ever caught a second submit of
    // the *same* conversation.
    //
    // Kept honest by submissions_conversation_owner_section_fk below, not by
    // convention. Without that FK these would be correct only as long as
    // every writer remembered to copy them from the conversation, and the
    // unique index would be enforcing a pair free to drift from the
    // conversation it names.
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sectionId: uuid("section_id")
      .notNull()
      .references(() => sections.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    submittedAt: timestamp("submitted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("submissions_org_idx").on(t.organizationId),
    // #128. Two consequences beyond keeping the denormalized pair honest:
    // (1) section_id is NOT NULL here while a tutor conversation's is NULL,
    // and a NOT NULL value never matches NULL, so a submission against a
    // tutor conversation becomes structurally impossible rather than merely
    // rejected by createSubmission's kind check; (2) it is what makes the
    // unique index below trustworthy.
    foreignKey({
      name: "submissions_conversation_owner_section_fk",
      columns: [t.conversationId, t.userId, t.sectionId],
      foreignColumns: [conversations.id, conversations.ownerUserId, conversations.sectionId],
    }).onDelete("cascade"),
    // #128, the actual fix.
    //
    // This cap is an accepted simplification, not a settled product rule. It
    // keeps ONE submission per (student, section) and restart voids the
    // previous one, so the platform retains no attempt history.
    //
    // The reasoning -- and the argument that `submissions` should instead be
    // an append-only attempt table, which was deferred rather than refuted --
    // is discussion #249. #250 is the work item. If attempts become
    // first-class this becomes a partial unique index over live rows; read
    // #249 before widening or removing it.
    uniqueIndex("submissions_user_section_uq").on(t.userId, t.sectionId),
  ],
);

// ---------- SectionAnswer ----------
// #164: the non-interactive counterpart to a conversation -- one row per
// (user, section), upserted on submit-and-revise (Resolved Design Decision
// 19 in the M3 plan: not a history table, matches submitSection's own
// existing update-in-place resubmission pattern; #128's actual ambiguity is
// about a conversation's restart cycle, which doesn't exist for this
// section type). organization_id is denormalized, same rationale as
// submissions above.

export const sectionAnswers = pgTable(
  "section_answers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sectionId: uuid("section_id")
      .notNull()
      .references(() => sections.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("section_answers_user_section_uq").on(t.userId, t.sectionId),
    index("section_answers_org_idx").on(t.organizationId),
  ],
);

// ---------- HomeworkProgressWidgetResponse ----------
// #165: one row per (user, widget) -- nullable pre/post pair on a single
// row is deliberate (per the issue's own Implementation Notes): keeps the
// pairing trivial to query and makes partial completion (pre answered,
// post never answered) a natural state rather than a correlation problem
// across two event rows.

export const homeworkProgressWidgetResponses = pgTable(
  "homework_progress_widget_responses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    widgetId: uuid("widget_id")
      .notNull()
      .references(() => homeworkProgressWidgets.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // #176: sole exception among runtime.ts's tenant-data tables until now --
    // its sibling section_answers already carries this. No direct security
    // hole today (submitWidgetResponse verifies the full parent chain before
    // writing), but FERPA deletion (#51) and export (#91, #165) need a
    // direct org predicate rather than a three-table join.
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    preValue: integer("pre_value"),
    preSubmittedAt: timestamp("pre_submitted_at", { withTimezone: true }),
    postValue: integer("post_value"),
    postSubmittedAt: timestamp("post_submitted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("hpwr_widget_user_uq").on(t.widgetId, t.userId),
    index("hpwr_org_idx").on(t.organizationId),
    check("hpwr_pre_value_range_chk", sql`${t.preValue} IS NULL OR (${t.preValue} >= 0 AND ${t.preValue} <= 10)`),
    check("hpwr_post_value_range_chk", sql`${t.postValue} IS NULL OR (${t.postValue} >= 0 AND ${t.postValue} <= 10)`),
  ],
);

// ---------- Grade ----------
// N:1 from submission (AI-first, instructor override allowed as a second
// row). CHECK enforces exactly one of (graded_by_ai, grader_membership_id
// set) -- an AI grade can never carry a human grader FK and vice versa.
// grader_membership_id is ON DELETE RESTRICT, not SET NULL: Postgres runs
// SET NULL as a real UPDATE on the referencing row, which the consistency
// CHECK below would then reject for any human-graded grade (graded_by_ai =
// false, grader_membership_id about to become NULL) -- restrict makes that
// state unreachable instead of making the delete crash on it. A grader's
// membership can't be deleted while they have recorded grades; a future
// retention story handles reassignment/anonymization explicitly.

export const grades = pgTable(
  "grades",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // ON DELETE RESTRICT, not CASCADE: submissions.conversation_id (and
    // conversations.owner_user_id above it) still cascade, so a grade is
    // the choke point that stops "delete a user" from silently erasing
    // their FERPA education records. Deleting a user with a graded
    // submission is blocked until that grade is explicitly handled (see
    // docs/architecture/multi-tenant-data-model.md §3.5 Q5). A user with
    // no graded submissions is NOT automatically deletable, though --
    // llm_call_logs' own RESTRICT FKs (below) form a second, independent
    // gate on the same cascade path, and most conversations have at least
    // one logged LLM call whether or not they were ever graded.
    //
    // This gate does NOT apply to organization deletion (#138, correcting
    // a wrong claim made here twice before): organizationId below is its
    // own direct CASCADE straight to `organizations`, created earlier
    // (migration 0004) than the courses->conversations->submissions chain
    // this RESTRICT sits at the bottom of. Postgres fires FK triggers in
    // constraint-creation order, so DELETE FROM organizations cascades
    // this table away directly before the deeper chain ever reaches this
    // RESTRICT -- deleting an org silently erases its grades and
    // llm_call_logs, with no gate. Verified empirically; see the doc link
    // above for the full mechanism and what a real org-offboarding flow
    // would need to add.
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => submissions.id, { onDelete: "restrict" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    graderMembershipId: uuid("grader_membership_id").references(
      () => courseMemberships.id,
      { onDelete: "restrict" },
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
    // grader_membership_id is a RESTRICT FK cascade path (#133) and the
    // lookup for "all grades by this grader" -- found in PR #127 review, #135.
    index("grades_grader_membership_idx").on(t.graderMembershipId),
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
    // message_id/grade_id are both the primary render-time lookup ("citations
    // for this message/grade") and cascade-delete FK paths -- found in PR
    // #127 review, #135.
    index("citations_message_idx").on(t.messageId),
    index("citations_grade_idx").on(t.gradeId),
    check(
      "citations_single_source_chk",
      sql`num_nonnulls(${t.messageId}, ${t.gradeId}) = 1`,
    ),
    // Both null (no span -- citation covers the whole chunk) or both set
    // and sane; a half-set span is as meaningless as a backwards one.
    // The equality clause is required, not redundant with the range clause
    // below: with span_end NULL, `span_end >= 0` evaluates to SQL NULL, and
    // Postgres CHECK constraints treat a NULL result as passing (only FALSE
    // rejects a row) -- so (5, NULL) silently passed this CHECK without it
    // (found in PR #127 round-2 review, #140).
    check(
      "citations_span_range_chk",
      sql`(${t.spanStart} IS NULL) = (${t.spanEnd} IS NULL)
          AND (${t.spanStart} IS NULL
            OR (${t.spanStart} >= 0 AND ${t.spanEnd} >= 0 AND ${t.spanStart} <= ${t.spanEnd}))`,
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

export const sectionAnswersRelations = relations(sectionAnswers, ({ one }) => ({
  section: one(sections, {
    fields: [sectionAnswers.sectionId],
    references: [sections.id],
  }),
  user: one(users, {
    fields: [sectionAnswers.userId],
    references: [users.id],
  }),
  organization: one(organizations, {
    fields: [sectionAnswers.organizationId],
    references: [organizations.id],
  }),
}));

export const homeworkProgressWidgetResponsesRelations = relations(homeworkProgressWidgetResponses, ({ one }) => ({
  widget: one(homeworkProgressWidgets, {
    fields: [homeworkProgressWidgetResponses.widgetId],
    references: [homeworkProgressWidgets.id],
  }),
  user: one(users, {
    fields: [homeworkProgressWidgetResponses.userId],
    references: [users.id],
  }),
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
//
// #317 review, #341: both FKs were ON DELETE RESTRICT when this table had
// no writer (docs/architecture/multi-tenant-data-model.md §3.5 point 5's
// original reasoning: silently losing cost/telemetry accounting to a
// cascade is worse than blocking the delete). #317 makes chat.ts write one
// row per turn, so RESTRICT now blocks the two hard-delete paths in
// repositories/homeworks.ts (`updateHomework`'s section removal,
// `deleteHomework`) the moment any section has ever had a single chat
// turn -- effectively every homework by mid-term, with the resulting
// `23503` falling through to a generic 503 with no recovery path (a
// student's own conversation soft-deletes instead, dodging this
// entirely -- routes/conversations.ts:341's own comment). SET NULL instead
// -- same choice llm_config_id already makes two lines below for the
// analogous "the row it references can go away" case -- preserves the
// accounting these FKs exist to protect (the cost/telemetry row survives
// intact, just detached) rather than either destroying it via a cascade or
// blocking the delete outright. `grades.submission_id` keeps RESTRICT:
// graded work is written far less often and isn't a per-turn hot path.

export const llmCallLogs = pgTable(
  "llm_call_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Nullable: a call that errors before the assistant message is
    // persisted (provider timeout, malformed response) has nothing to
    // attach to yet -- error_flag rows may have a null message_id.
    // unique() still holds; Postgres doesn't treat multiple NULLs as
    // duplicates under a unique constraint. Also goes null on the
    // message's own deletion now (see #341 note above).
    messageId: uuid("message_id")
      .unique()
      .references(() => messages.id, { onDelete: "set null" }),
    // Nullable as of #341 (was notNull): the conversation this call
    // belonged to can now be hard-deleted without this row disappearing.
    conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
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
    // SET NULL path (config deletion/rotation) and the "usage by config"
    // query shape -- found in PR #127 review, #135.
    index("llm_call_logs_config_idx").on(t.llmConfigId),
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
