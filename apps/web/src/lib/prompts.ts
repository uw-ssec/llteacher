import { and, desc, eq, type SQL } from "drizzle-orm";
import type { Db } from "../db/client";
import { homeworks, promptTemplates, sections } from "../db/schema";
import type { CourseScope, OrgScope } from "../server/repositories/scope";
import { deriveHomeworkStatus, isUnreleased } from "../server/repositories/homeworks";

/* --------------------------------------------------------------------------
   Prompt assembly (#25) -- replaces chat.ts's hardcoded SYSTEM_PROMPT with
   real context: a resolved prompt_templates row (or a built-in fallback),
   plus section title/content when the conversation is section-kind.

   Two responsibilities, kept separate per the issue's own ask ("route the
   lookup through one resolver function"):

     resolvePromptTemplate  -- WHICH template applies (walks section ->
                                homework -> course -> org, Django parity --
                                see the doc comment on promptTemplates in
                                db/schema/content.ts)
     assembleSystemPrompt   -- pure composition of that template's content +
                                section context + the tutor guardrail into
                                one system-prompt string

   Resolved ONCE per conversation (at creation, by the caller -- see
   sectionConversations.ts/conversations.ts) and the chosen template's id is
   pinned onto conversations.promptTemplateId, never re-resolved per-message
   (cross-cutting invariant, #30). chat.ts uses getPinnedPromptTemplateContent for
   that pinned id, falling back to a fresh resolvePromptTemplate call only
   for conversations that predate the promptTemplateId column.
   -------------------------------------------------------------------------- */

/** The safe, code-level fallback when NO prompt_templates row exists at
 *  ANY scope -- not org/institution/subject-specific text (#317 review,
 *  #325: "move the institution- and subject-specific fallback text into
 *  the seeded org template; make the built-in fallback neutral"). LLTeacher
 *  is the shared base for multiple CDI-funded projects, each seeding its
 *  own org-scoped prompt_templates row (scripts/seed.ts's TUTOR_BASE_PROMPT
 *  is the UW-statistics one) -- this string only fires for an org that has
 *  seeded nothing at all, so it must not assume any particular subject.
 *  Never null/crash; see #25's own "missing prompt at any scope" testing
 *  requirement. */
export const DEFAULT_SYSTEM_PROMPT = `You are an AI tutor. Guide students through problems using the Socratic method: ask leading questions, build intuition step by step, never just dump the answer.

Be warm, curious, and patient. Prefer questions over assertions.`;

/** Django parity, verbatim (`_build_current_prompt`,
 *  apps/llm/src/llm/services.py:367): "Please respond as an AI tutor
 *  helping the student with this section. Guide them without giving away
 *  the complete answer." Django re-injects this into every per-turn user
 *  message; here it's assembled once into the system prompt instead (see
 *  the cross-cutting invariant on prompt-template pinning above) -- the
 *  pedagogical contract is what's preserved verbatim, not the delivery
 *  mechanism. Written scope-agnostic ("the student", not "this section")
 *  so the same sentence serves both section- and tutor-kind conversations.
 *
 *  #317 review, #325: only appended when resolution fell through to
 *  DEFAULT_SYSTEM_PROMPT above (assembleSystemPrompt's `isDefaultPrompt`
 *  param) -- a real prompt_templates row, at any scope, already states its
 *  own pedagogy and gets to be the final word on it. Unconditionally
 *  appending this sentence to every resolved template meant a project that
 *  deliberately wants its tutor to sometimes give a direct answer (e.g. a
 *  reference/lookup-style homework) could author a template saying so and
 *  have it contradicted by a sentence it had no way to remove. */
export const TUTOR_GUARDRAIL =
  "Respond as an AI tutor helping the student. Guide them without giving away the complete answer.";

export interface ResolvedPromptTemplate {
  /** Null when nothing was found at any scope (DEFAULT_SYSTEM_PROMPT was
   *  used) -- there is no real template row to pin. */
  id: string | null;
  content: string;
  version: number | null;
}

interface ScopedTemplateRow {
  id: string;
  content: string;
  version: number;
  composeWithParent: boolean;
}

/** The most recent active row matching a single scope predicate --
 *  `.orderBy(desc(version)).limit(1)` is the fix for #317 review finding
 *  #324 ("nondeterministic selection"): the old code destructured `[row]`
 *  from an unordered select, so two active rows at one scope (a state the
 *  new partial unique index below prevents going forward, but a pre-
 *  migration DB or a raw-SQL insert could still produce) resolved to
 *  whichever row Postgres happened to return first. */
async function fetchActiveTemplateForScope(db: Db, scopePredicate: SQL): Promise<ScopedTemplateRow | null> {
  const [row] = await db
    .select({
      id: promptTemplates.id,
      content: promptTemplates.content,
      version: promptTemplates.version,
      composeWithParent: promptTemplates.composeWithParent,
    })
    .from(promptTemplates)
    .where(scopePredicate)
    .orderBy(desc(promptTemplates.version))
    .limit(1);
  return row ?? null;
}

/** Tries each scope level from `index` onward, returning the first active
 *  match -- or DEFAULT_SYSTEM_PROMPT if none exists at any remaining level.
 *  `levels[i]` is null for a level with nothing to scope to (no
 *  homeworkId when `sectionId` was itself null), and is simply skipped.
 *
 *  #317 review finding #324 ("compose_with_parent is inert"): when the
 *  matched row has `composeWithParent: true`, this recurses into the next
 *  level (the row's own scope's "parent" in the section -> homework ->
 *  course -> org walk) and concatenates that resolution's content ahead of
 *  the matched row's own -- "parent then child", per the issue's own
 *  wording. The returned id/version always identify the most specific
 *  (child) row actually matched, since that is what a conversation should
 *  pin to; only `content` reflects the composition. */
async function resolveFromLevel(db: Db, levels: Array<SQL | null>, index: number): Promise<ResolvedPromptTemplate> {
  for (let i = index; i < levels.length; i++) {
    const predicate = levels[i];
    if (!predicate) continue;
    const row = await fetchActiveTemplateForScope(db, predicate);
    if (!row) continue;
    if (row.composeWithParent) {
      const parent = await resolveFromLevel(db, levels, i + 1);
      return { id: row.id, content: `${parent.content}\n\n${row.content}`, version: row.version };
    }
    return { id: row.id, content: row.content, version: row.version };
  }
  return { id: null, content: DEFAULT_SYSTEM_PROMPT, version: null };
}

/** Walks section -> homework -> course -> org -> built-in fallback, per the
 *  resolution order documented on promptTemplates itself
 *  (db/schema/content.ts) -- by each level's own `scope_*_id` column. An
 *  earlier schema also had `sections.promptTemplateId` / `homeworks.
 *  promptTemplateId` override FKs alongside this resolution order (#317
 *  review finding #324: those FKs and this function's real resolution had
 *  diverged -- nothing in the codebase ever wrote them); #317 review, #347
 *  removed both columns rather than leave a second, inert representation
 *  of "which template applies" for a future change to trip over.
 *  `sectionId` is null for tutor-kind conversations (no section to resolve
 *  a homework from either; homework-level resolution is only ever reached
 *  via a section, matching the schema).
 *
 *  Org scoping (#30 cross-cutting invariant): every level's predicate is
 *  scoped to `orgScope`/`courseScope`/the caller-supplied `sectionId`,
 *  which the caller must have already verified belongs to the requester
 *  (mint via courseScopeFromAuthContext, never from unvalidated request
 *  input) -- this function does not itself re-check membership.
 *
 *  `knownHomeworkId` -- #317 review, #346: undefined (the default) means
 *  "look it up" (a `sections` select keyed on `sectionId`); any other value
 *  means the caller already has it and this function trusts it instead.
 *  chat.ts's caller already ran getSectionPromptContext one statement
 *  earlier, whose join has this exact column (PromptSectionContext.
 *  homeworkId) -- this parameter is what lets that caller skip the
 *  redundant re-read on the very fallback path (no pin yet) that's already
 *  paying for four scope-predicate reads. */
export async function resolvePromptTemplate(
  db: Db,
  orgScope: OrgScope,
  courseScope: CourseScope,
  sectionId: string | null,
  knownHomeworkId?: string | null,
): Promise<ResolvedPromptTemplate> {
  let homeworkId: string | null = null;
  if (sectionId) {
    if (knownHomeworkId !== undefined) {
      homeworkId = knownHomeworkId;
    } else {
      const [section] = await db.select({ homeworkId: sections.homeworkId }).from(sections).where(eq(sections.id, sectionId));
      homeworkId = section?.homeworkId ?? null;
    }
  }

  const levels: Array<SQL | null> = [
    sectionId ? and(eq(promptTemplates.scopeSectionId, sectionId), eq(promptTemplates.isActive, true))! : null,
    homeworkId ? and(eq(promptTemplates.scopeHomeworkId, homeworkId), eq(promptTemplates.isActive, true))! : null,
    and(eq(promptTemplates.scopeCourseId, courseScope), eq(promptTemplates.isActive, true))!,
    and(eq(promptTemplates.scopeOrganizationId, orgScope), eq(promptTemplates.isActive, true))!,
  ];

  return resolveFromLevel(db, levels, 0);
}

/** The pinned lookup chat.ts uses on every turn once a conversation has a
 *  promptTemplateId: exact row, by id, regardless of its current isActive
 *  state -- once pinned, a conversation keeps using it even if it's since
 *  been superseded (that's the entire point of pinning; see this module's
 *  doc comment). Null means the row is gone (onDelete: set null already
 *  cleared conversations.promptTemplateId in that case, so this is
 *  defensive, not a path production traffic should hit). */
export async function getPinnedPromptTemplateContent(db: Db, promptTemplateId: string): Promise<string | null> {
  const [row] = await db
    .select({ content: promptTemplates.content })
    .from(promptTemplates)
    .where(eq(promptTemplates.id, promptTemplateId));
  return row?.content ?? null;
}

export interface PromptSectionContext {
  homeworkTitle: string;
  sectionTitle: string;
  /** The section's problem-statement content (sections.content) -- NEVER
   *  the teacher-authored model solution (section_solutions, a separate
   *  1:1 table). Callers must not pass solution text here; there is no
   *  parameter for it, by design, so a solution can only leak into the
   *  student prompt via a caller that goes out of its way to mislabel it. */
  sectionContent: string;
  /** Not used by assembleSystemPrompt itself (optional so pure
   *  assembleSystemPrompt test fixtures don't need to supply it) -- carried
   *  through so callers that already fetched this row (chat.ts) don't need
   *  a second query just to get the homeworkId lib/llm-config.ts's
   *  resolveLLMConfig needs. getSectionPromptContext always sets it. */
  homeworkId?: string;
  /** #317 review, #326: the homework's own llm_config_id override, from the
   *  SAME sections->homeworks join this function already runs -- chat.ts
   *  used to re-read this one column via a second, separate `homeworks`
   *  select inside resolveLLMConfig itself, one statement after this
   *  function's own join already had it. resolveLLMConfig now takes this
   *  value directly instead of a homeworkId to look it up from. Optional
   *  for the same pure-test-fixture reason as homeworkId above;
   *  getSectionPromptContext always sets it (possibly to null, if the
   *  homework has no override). */
  homeworkLlmConfigId?: string | null;
  /** #317 review, blocking finding #4: true when the parent homework's
   *  derived status (deriveHomeworkStatus, repositories/homeworks.ts) is
   *  draft/scheduled/hidden -- i.e. the instructor has not released this
   *  section to students. Every sibling read path (submissions dashboard,
   *  homework detail route, section-answer read at
   *  routes/sectionAnswers.ts:102) gates on this; this one didn't, so a
   *  student holding a section's UUID from when it was live could still
   *  POST /api/chat with kind:"section" after it was hidden or expired and
   *  get the full problem statement back verbatim in the greeting,
   *  re-injected every turn. Not used by assembleSystemPrompt itself --
   *  the caller (chat.ts) is the one with authContext.canViewDraftsIn, so
   *  the caller decides whether this should actually block the turn. */
  isUnreleased?: boolean;
}

/** homework title + section title/content for assembleSystemPrompt's
 *  `section` parameter -- deliberately selects ONLY sections.content
 *  (the problem statement), never anything from section_solutions (a
 *  separate 1:1 table this function does not even join against). Course-
 *  scoped so a conversation's own courseId acts as the tenancy check;
 *  returns null for a sectionId that doesn't resolve within that scope
 *  (deleted section, cross-course id) rather than throwing -- chat.ts
 *  treats that as "build the prompt without section context" rather than
 *  failing the whole turn over stale section metadata.
 *
 *  A resolved row's `isUnreleased` still needs a caller-side gate (see that
 *  field's own doc comment) -- this function stays a pure lookup, not an
 *  authorization decision, since it has no access to the caller's role. */
export async function getSectionPromptContext(
  db: Db,
  courseScope: CourseScope,
  sectionId: string,
): Promise<PromptSectionContext | null> {
  const [row] = await db
    .select({
      sectionTitle: sections.title,
      sectionContent: sections.content,
      homeworkTitle: homeworks.title,
      homeworkId: homeworks.id,
      homeworkLlmConfigId: homeworks.llmConfigId,
      dueDate: homeworks.dueDate,
      publishedAt: homeworks.publishedAt,
      releasedAt: homeworks.releasedAt,
      isHidden: homeworks.isHidden,
      expiresAt: homeworks.expiresAt,
    })
    .from(sections)
    .innerJoin(homeworks, eq(sections.homeworkId, homeworks.id))
    .where(and(eq(sections.id, sectionId), eq(homeworks.courseId, courseScope)));
  if (!row) return null;
  const { dueDate, publishedAt, releasedAt, isHidden, expiresAt, ...context } = row;
  return {
    ...context,
    isUnreleased: isUnreleased(deriveHomeworkStatus({ dueDate, publishedAt, releasedAt, isHidden, expiresAt })),
  };
}

/** #305: section-conversation persona/wording -- moved here from
 *  repositories/sectionConversations.ts, which had no business owning prompt
 *  content (a repository module resolving org-facing copy is a layering
 *  violation; the fix is this signature living in the prompt-assembly
 *  module, not a lookup swap). Django parity greeting, verbatim from
 *  ConversationService._create_initial_message
 *  (apps/conversations/src/conversations/services.py). Stored as an
 *  `assistant` message by the caller, matching Django's MESSAGE_TYPE_AI --
 *  the tutor is speaking to the student, so it is not a `system` message. */
export function sectionGreeting(section: { order: number; title: string; content: string }): string {
  return `Hello! I'm here to help you with Section ${section.order}: ${section.title}.\n\n${section.content}\n\nHow can I assist you with this question?`;
}

/** #305: the `Section N: Title` conversation-title template, same
 *  reasoning as sectionGreeting above -- was duplicated verbatim at both of
 *  startSectionConversation's and restartSectionConversation's call sites. */
export function sectionConversationTitle(section: { order: number; title: string }): string {
  return `Section ${section.order}: ${section.title}`;
}

/** Pure composition: template content + (optional) section context +
 *  (conditionally) the tutor guardrail -> one system-prompt string. No db
 *  access, no I/O -- the whole point of extracting this from
 *  resolvePromptTemplate is that it's trivially snapshot-testable (#25's
 *  own ask).
 *
 *  Section content is wrapped in an XML-style delimiter per the issue's own
 *  pitfall guidance: section.content is instructor-authored but still
 *  untrusted-as-instructions input from the model's point of view, so it's
 *  fenced rather than interpolated bare into the surrounding prompt.
 *
 *  `isDefaultPrompt` (#317 review, #325): true only when `templateContent`
 *  IS DEFAULT_SYSTEM_PROMPT (resolution found no real prompt_templates row
 *  at any scope) -- see TUTOR_GUARDRAIL's own doc comment for why a real
 *  template must not have this sentence forced onto it. Callers pass this
 *  explicitly (chat.ts derives it from ResolvedPromptTemplate.id === null)
 *  rather than this function re-deriving it via string comparison against
 *  DEFAULT_SYSTEM_PROMPT, which would misfire for any org template whose
 *  content happens to match it verbatim. */
export function assembleSystemPrompt(
  templateContent: string,
  section?: PromptSectionContext,
  isDefaultPrompt = false,
): string {
  const parts = [templateContent.trim()];
  if (section) {
    parts.push(
      [
        `You are helping with "${section.homeworkTitle}", ${section.sectionTitle}.`,
        "<section_content>",
        section.sectionContent,
        "</section_content>",
      ].join("\n"),
    );
  }
  if (isDefaultPrompt) parts.push(TUTOR_GUARDRAIL);
  return parts.join("\n\n");
}
