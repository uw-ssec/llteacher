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
    provider: llmProviderEnum("provider").notNull(),
    modelName: text("model_name").notNull(),
    temperature: doublePrecision("temperature").notNull().default(0.7),
    maxCompletionTokens: integer("max_completion_tokens")
      .notNull()
      .default(1000),
    credentialId: uuid("credential_id").references(
      () => organizationCredentials.id,
      { onDelete: "set null" },
    ),
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
  ],
);

// ---------- Homework ----------
// Assignment owned by a Course. prompt_template_id and llm_config_id are
// nullable overrides; resolution falls back to Course / Organization defaults
// when null. created_by_id references a CourseMembership (not a User), so a
// TA or co-instructor authoring an assignment is first-class.

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
    promptTemplateId: uuid("prompt_template_id").references(
      () => promptTemplates.id,
      { onDelete: "set null" },
    ),
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
    promptTemplateId: uuid("prompt_template_id").references(
      () => promptTemplates.id,
      { onDelete: "set null" },
    ),
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
  promptTemplate: one(promptTemplates, {
    fields: [homeworks.promptTemplateId],
    references: [promptTemplates.id],
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
  promptTemplate: one(promptTemplates, {
    fields: [sections.promptTemplateId],
    references: [promptTemplates.id],
  }),
  solution: one(sectionSolutions),
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
