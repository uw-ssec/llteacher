import { relations, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
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
  vector,
} from "drizzle-orm/pg-core";

import {
  courseMemberships,
  courses,
  organizationCredentials,
  organizations,
} from "./identity";

// ---------- Enums ----------

export const llmProviderEnum = pgEnum("llm_provider", [
  "openai",
  "anthropic",
  "claude_for_education",
  "openrouter",
  "local",
  // #178: UW SSEC's LiteLLM gateway. Appended, not inserted, so existing
  // rows' enum ordinals never shift (Postgres ALTER TYPE ... ADD VALUE is
  // append-only within a migration anyway; this keeps the source and the
  // generated migration in agreement).
  "llmoxie",
]);

export const materialSourceEnum = pgEnum("material_source_type", [
  "pdf",
  "slides",
  "transcript",
  "syllabus",
  "other",
]);

// #164: "conversation" is a student working the section via chat (the
// existing behavior); "non_interactive" collects a section_answers row
// instead (see runtime.ts's sectionAnswers table).
export const sectionTypeEnum = pgEnum("section_type", [
  "conversation",
  "non_interactive",
]);

// ---------- LLMConfig ----------
// Per-Organization pool of model configurations. is_default is per-org; at
// most one row per org may have is_default = true (enforced via partial
// unique index).

export const llmConfigs = pgTable(
  "llm_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // #31: the instructor-facing name. Django's llm app keyed its config
    // list on this, and the admin console's catalog rows have always
    // displayed one -- it was the last field still coming from fixtures.
    name: text("name").notNull(),
    provider: llmProviderEnum("provider").notNull(),
    modelName: text("model_name").notNull(),
    // #31: the tutor's standing instructions -- what it is told it is.
    //
    // On the overlap with prompt_templates, which is deliberate and not
    // duplication: a config answers "which model, speaking how, by default
    // for this organization". prompt_templates is the SCOPED, VERSIONED
    // override layer above it -- per course, homework or section, with
    // compose_with_parent to stack rather than replace, and previous_version_id
    // so a conversation can pin the wording it started under. Neither
    // subsumes the other: an org that has written no templates still needs a
    // working tutor voice, and a homework that overrides the voice still
    // needs a model to run on. Resolution order is documented on
    // resolveLlmConfig in repositories/llmConfigs.ts.
    basePrompt: text("base_prompt").notNull().default(""),
    temperature: doublePrecision("temperature").notNull().default(0.7),
    maxCompletionTokens: integer("max_completion_tokens")
      .notNull()
      .default(1000),
    credentialId: uuid("credential_id").references(
      () => organizationCredentials.id,
      { onDelete: "set null" },
    ),
    // #98: one optional fallback, deliberately not a chain. A provider
    // outage or a model-specific incident degrades to a backup instead of
    // failing a student mid-homework. ON DELETE SET NULL rather than
    // RESTRICT: deleting a config that happens to be someone's fallback
    // should drop the fallback, not block the delete -- the primary keeps
    // working, which is the safe direction.
    //
    // One level, not N, is the recorded simplicity: an arbitrary chain needs
    // cycle detection at every hop, makes "which model served this turn"
    // unbounded in the call log, and answers a failure mode nobody has yet
    // had. The self-reference check below is the whole of the cycle
    // problem at depth one.
    fallbackLlmConfigId: uuid("fallback_llm_config_id").references(
      (): AnyPgColumn => llmConfigs.id,
      { onDelete: "set null" },
    ),
    // #317 review, #349 (requirement, "move rates to configuration"):
    // per-config $/1M-token rates for llm_call_logs.cost_cents
    // (lib/llm-config.ts's estimateCostCents) -- the natural, per-tenant
    // home for a rate that a TS literal (MODEL_PRICING_PER_MILLION_TOKENS,
    // same file) can't be: OpenRouter and a gateway like LLMOxie both front
    // many models at independently-set, changing rates, and a literal means
    // a code change and redeploy per org per model change. Both nullable,
    // and BOTH must be set for estimateCostCents to use them (a half-known
    // rate isn't a half-known cost, it's an unknown one) -- null falls
    // through to the static table, which itself falls through to null
    // ("unknown," never a guessed number; see that table's own doc
    // comment).
    pricePerMillionInputTokens: doublePrecision("price_per_million_input_tokens"),
    pricePerMillionOutputTokens: doublePrecision("price_per_million_output_tokens"),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("llm_configs_org_idx").on(t.organizationId),
    uniqueIndex("llm_configs_org_default_uq")
      .on(t.organizationId)
      .where(sql`${t.isDefault} = true`),
    check(
      "llm_configs_temperature_range_chk",
      sql`${t.temperature} >= 0 AND ${t.temperature} <= 2`,
    ),
    // #31: an inactive config cannot be the org default. The default is what
    // every course without an explicit choice resolves to, so a deactivated
    // one is an org-wide outage dressed as a settings change -- and the
    // partial unique index above would happily hold it there, since it only
    // constrains how MANY defaults exist, not whether the one is usable.
    check(
      "llm_configs_active_required_for_default_chk",
      sql`NOT (${t.isDefault} AND NOT ${t.isActive})`,
    ),
    // #98: a config cannot be its own fallback. At depth one this is the
    // entire cycle problem -- there is no A -> B -> A to detect, because B
    // is never consulted for a fallback of its own (see resolveFallback in
    // repositories/llmConfigs.ts, which reads exactly one hop).
    check(
      "llm_configs_fallback_not_self_chk",
      sql`${t.fallbackLlmConfigId} IS NULL OR ${t.fallbackLlmConfigId} <> ${t.id}`,
    ),
  ],
);

// ---------- PromptTemplate ----------
// Polymorphic scope: exactly one of (scope_organization_id, scope_course_id,
// scope_homework_id, scope_section_id) is non-null. Enforced by a CHECK using
// num_nonnulls(). Resolution at runtime walks section -> homework -> course
// -> org.
//
// Versioned via previous_version_id (self-FK). Each edit creates a new row
// pointing back to the prior version; existing Conversations pin to the
// version they started with (see §6.3 schema, runtime.ts).

export const promptTemplates = pgTable(
  "prompt_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    scopeOrganizationId: uuid("scope_organization_id").references(
      () => organizations.id,
      { onDelete: "cascade" },
    ),
    scopeCourseId: uuid("scope_course_id").references(() => courses.id, {
      onDelete: "cascade",
    }),
    scopeHomeworkId: uuid("scope_homework_id").references(
      (): AnyPgColumn => homeworks.id,
      { onDelete: "cascade" },
    ),
    scopeSectionId: uuid("scope_section_id").references(
      (): AnyPgColumn => sections.id,
      { onDelete: "cascade" },
    ),

    previousVersionId: uuid("previous_version_id").references(
      (): AnyPgColumn => promptTemplates.id,
      { onDelete: "set null" },
    ),
    version: integer("version").notNull().default(1),
    content: text("content").notNull(),
    composeWithParent: boolean("compose_with_parent").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "prompt_templates_exactly_one_scope_chk",
      sql`num_nonnulls(${t.scopeOrganizationId}, ${t.scopeCourseId}, ${t.scopeHomeworkId}, ${t.scopeSectionId}) = 1`,
    ),
    index("prompt_templates_scope_org_idx").on(t.scopeOrganizationId),
    index("prompt_templates_scope_course_idx").on(t.scopeCourseId),
    index("prompt_templates_scope_homework_idx").on(t.scopeHomeworkId),
    index("prompt_templates_scope_section_idx").on(t.scopeSectionId),
    // #317 review finding #324: mirrors llm_configs_org_default_uq -- at
    // most one ACTIVE template per concrete scope target. Postgres unique
    // indexes never treat two NULLs as a conflict, so each index only
    // constrains rows that actually scope to that column; a row's other
    // three scope columns (always NULL, per the CHECK above) never collide
    // with anything here.
    uniqueIndex("prompt_templates_scope_org_active_uq")
      .on(t.scopeOrganizationId)
      .where(sql`${t.isActive} = true`),
    uniqueIndex("prompt_templates_scope_course_active_uq")
      .on(t.scopeCourseId)
      .where(sql`${t.isActive} = true`),
    uniqueIndex("prompt_templates_scope_homework_active_uq")
      .on(t.scopeHomeworkId)
      .where(sql`${t.isActive} = true`),
    uniqueIndex("prompt_templates_scope_section_active_uq")
      .on(t.scopeSectionId)
      .where(sql`${t.isActive} = true`),
  ],
);

// ---------- Homework ----------
// Assignment owned by a Course. llm_config_id is a nullable override;
// resolution falls back to Course / Organization defaults when null
// (lib/llm-config.ts's resolveLLMConfig). Prompt-template resolution is by
// prompt_templates.scope_*_id only (lib/prompts.ts's resolvePromptTemplate)
// -- there is deliberately no homeworks/sections-level override column for
// it; #317 review, #347 removed the prompt_template_id column that used to
// suggest one, after finding nothing anywhere had ever read or written it.
// created_by_id references a CourseMembership (not a User), so a TA or
// co-instructor authoring an assignment is first-class.

export const homeworks = pgTable(
  "homeworks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    createdById: uuid("created_by_id")
      .notNull()
      .references(() => courseMemberships.id, { onDelete: "restrict" }),
    llmConfigId: uuid("llm_config_id").references(() => llmConfigs.id, {
      onDelete: "set null",
    }),
    // Draft/publish state (#94). Both null = draft (deliberate deviation from
    // Django parity, which made homeworks visible immediately on creation).
    // publishedAt is set the moment an instructor hits "publish" in the admin
    // UI; releasedAt is the (possibly future) instant the homework actually
    // becomes visible to students. Status is derived on read from these two
    // plus dueDate — see deriveHomeworkStatus in repositories/homeworks.ts.
    // No separate `status` enum column: it would just be a cache of a pure
    // function of these three timestamps, and could drift out of sync.
    publishedAt: timestamp("published_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    // #166: is_hidden is the single source of truth for student access,
    // independent of publish state (an instructor can pull a *published*
    // homework from view without unpublishing it). expires_at is optional
    // auto-hide once passed. See deriveHomeworkStatus and Resolved Design
    // Decision 17 for the "hidden" vs "archived" call.
    isHidden: boolean("is_hidden").notNull().default(false),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    title: text("title").notNull(),
    description: text("description").notNull(),
    dueDate: timestamp("due_date", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("homeworks_course_idx").on(t.courseId),
    index("homeworks_created_by_idx").on(t.createdById),
  ],
);

// ---------- Section ----------
// Ordered sub-part of a Homework. Sara's level-2 (problem-specific) prompts
// live as PromptTemplate rows scoped to a section. order is 1-indexed,
// capped at 20 to match the legacy Django constraint.

export const sections = pgTable(
  "sections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    homeworkId: uuid("homework_id")
      .notNull()
      .references(() => homeworks.id, { onDelete: "cascade" }),
    order: integer("order").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    // #164: defaults to "conversation" so every existing row is unchanged.
    // non_interactive sections collect a section_answers row instead of a
    // conversation -- see runtime.ts's sectionAnswers table.
    type: sectionTypeEnum("type").notNull().default("conversation"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("sections_homework_order_uq").on(t.homeworkId, t.order),
    check(
      "sections_order_range_chk",
      sql`${t.order} >= 1 AND ${t.order} <= 20`,
    ),
  ],
);

// ---------- HomeworkProgressWidget ----------
// #165: an ordered pre/post self-assessment prompt pair, authored per
// homework. order is 1-indexed, capped at 20 -- same idiom as sections.

export const homeworkProgressWidgets = pgTable(
  "homework_progress_widgets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    homeworkId: uuid("homework_id")
      .notNull()
      .references(() => homeworks.id, { onDelete: "cascade" }),
    prePrompt: text("pre_prompt").notNull(),
    postPrompt: text("post_prompt").notNull(),
    order: integer("order").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("homework_progress_widgets_homework_order_uq").on(t.homeworkId, t.order),
    check(
      "homework_progress_widgets_order_range_chk",
      sql`${t.order} >= 1 AND ${t.order} <= 20`,
    ),
  ],
);

// ---------- SectionSolution ----------
// Teacher-provided model solution. Optional; 1:1 with Section when present.
// FK lives on this side (vs. on Section) so a Section can exist without a
// Solution but every Solution is bound to exactly one Section.

export const sectionSolutions = pgTable(
  "section_solutions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sectionId: uuid("section_id")
      .notNull()
      .references(() => sections.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("section_solutions_section_uq").on(t.sectionId)],
);

// ---------- CourseMaterial ----------
// Uploaded course artifact (PDF, slide deck, lecture transcript, etc.) used
// as RAG grounding. upload_metadata is open-ended jsonb (page count, mime,
// extraction notes); structure it via a Zod schema at the route layer rather
// than constraining the column.

export const courseMaterials = pgTable(
  "course_materials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    uploadedById: uuid("uploaded_by_id")
      .notNull()
      .references(() => courseMemberships.id, { onDelete: "restrict" }),
    sourceType: materialSourceEnum("source_type").notNull(),
    title: text("title").notNull(),
    originalFilename: text("original_filename"),
    uploadMetadata: jsonb("upload_metadata"),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("course_materials_course_idx").on(t.courseId)],
);

// ---------- MaterialChunk ----------
// Chunked + embedded text from a CourseMaterial. Vector embedding via pgvector
// (extension must be enabled; see apps/web/src/db/init/01_extensions.sql).
// Default dimension = 1536 (OpenAI text-embedding-3-small); changing requires
// a migration.

export const materialChunks = pgTable(
  "material_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    materialId: uuid("material_id")
      .notNull()
      .references(() => courseMaterials.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    text: text("text").notNull(),
    embedding: vector("embedding", { dimensions: 1536 }),
    tokenCount: integer("token_count").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("material_chunks_material_ordinal_uq").on(
      t.materialId,
      t.ordinal,
    ),
    index("material_chunks_material_idx").on(t.materialId),
  ],
);

// ---------- AgentDefinition ----------
// Per-Organization registry of multi-agent personas (tutor, transcript
// evaluator, profile builder, ...). Each persona has a default prompt and
// LLM config; per-conversation overrides happen at the ConversationAgent
// row in §6.3.

export const agentDefinitions = pgTable(
  "agent_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    roleDescription: text("role_description").notNull(),
    defaultPromptTemplateId: uuid("default_prompt_template_id").references(
      () => promptTemplates.id,
      { onDelete: "set null" },
    ),
    defaultLlmConfigId: uuid("default_llm_config_id").references(
      () => llmConfigs.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("agent_definitions_org_name_uq").on(t.organizationId, t.name),
  ],
);

// ---------- Relations ----------

export const llmConfigsRelations = relations(llmConfigs, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [llmConfigs.organizationId],
    references: [organizations.id],
  }),
  credential: one(organizationCredentials, {
    fields: [llmConfigs.credentialId],
    references: [organizationCredentials.id],
  }),
  homeworks: many(homeworks),
  agentDefinitions: many(agentDefinitions),
}));

export const promptTemplatesRelations = relations(
  promptTemplates,
  ({ one, many }) => ({
    scopeOrganization: one(organizations, {
      fields: [promptTemplates.scopeOrganizationId],
      references: [organizations.id],
    }),
    scopeCourse: one(courses, {
      fields: [promptTemplates.scopeCourseId],
      references: [courses.id],
    }),
    scopeHomework: one(homeworks, {
      fields: [promptTemplates.scopeHomeworkId],
      references: [homeworks.id],
    }),
    scopeSection: one(sections, {
      fields: [promptTemplates.scopeSectionId],
      references: [sections.id],
    }),
    previousVersion: one(promptTemplates, {
      fields: [promptTemplates.previousVersionId],
      references: [promptTemplates.id],
      relationName: "prompt_template_history",
    }),
    nextVersions: many(promptTemplates, {
      relationName: "prompt_template_history",
    }),
  }),
);

export const homeworksRelations = relations(homeworks, ({ one, many }) => ({
  course: one(courses, {
    fields: [homeworks.courseId],
    references: [courses.id],
  }),
  createdBy: one(courseMemberships, {
    fields: [homeworks.createdById],
    references: [courseMemberships.id],
  }),
  llmConfig: one(llmConfigs, {
    fields: [homeworks.llmConfigId],
    references: [llmConfigs.id],
  }),
  sections: many(sections),
}));

export const sectionsRelations = relations(sections, ({ one }) => ({
  homework: one(homeworks, {
    fields: [sections.homeworkId],
    references: [homeworks.id],
  }),
  solution: one(sectionSolutions),
}));

export const homeworkProgressWidgetsRelations = relations(homeworkProgressWidgets, ({ one }) => ({
  homework: one(homeworks, {
    fields: [homeworkProgressWidgets.homeworkId],
    references: [homeworks.id],
  }),
}));

export const sectionSolutionsRelations = relations(
  sectionSolutions,
  ({ one }) => ({
    section: one(sections, {
      fields: [sectionSolutions.sectionId],
      references: [sections.id],
    }),
  }),
);

export const courseMaterialsRelations = relations(
  courseMaterials,
  ({ one, many }) => ({
    course: one(courses, {
      fields: [courseMaterials.courseId],
      references: [courses.id],
    }),
    uploadedBy: one(courseMemberships, {
      fields: [courseMaterials.uploadedById],
      references: [courseMemberships.id],
    }),
    chunks: many(materialChunks),
  }),
);

export const materialChunksRelations = relations(materialChunks, ({ one }) => ({
  material: one(courseMaterials, {
    fields: [materialChunks.materialId],
    references: [courseMaterials.id],
  }),
}));

export const agentDefinitionsRelations = relations(
  agentDefinitions,
  ({ one }) => ({
    organization: one(organizations, {
      fields: [agentDefinitions.organizationId],
      references: [organizations.id],
    }),
    defaultPromptTemplate: one(promptTemplates, {
      fields: [agentDefinitions.defaultPromptTemplateId],
      references: [promptTemplates.id],
    }),
    defaultLlmConfig: one(llmConfigs, {
      fields: [agentDefinitions.defaultLlmConfigId],
      references: [llmConfigs.id],
    }),
  }),
);
