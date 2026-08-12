import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { homeworks, promptTemplates, sections } from "../db/schema";
import type { CourseScope, OrgScope } from "../server/repositories/scope";

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
   (cross-cutting invariant, #30). chat.ts uses getPinnedPromptTemplate for
   that pinned id, falling back to a fresh resolvePromptTemplate call only
   for conversations that predate the promptTemplateId column.
   -------------------------------------------------------------------------- */

/** Django parity default (`apps/llm/src/llm/services.py`'s Socratic-method
 *  system prompt) -- the safe fallback when no prompt_templates row exists
 *  at any scope. Never null/crash; see #25's own "missing prompt at any
 *  scope" testing requirement. */
export const DEFAULT_SYSTEM_PROMPT = `You are an AI tutor for an introductory statistics course at the University of Washington. Your job is to guide students through homework problems using the Socratic method: ask leading questions, build intuition step by step, never just dump the answer.

You have one structured rendering tool available: showDefinition. Call it whenever you are formally introducing a named statistical concept ("p-value", "null hypothesis", "standard error", "confidence interval", "type I error", etc.) — give the student a polished definition card with the term and a 1–2 sentence plain-language body. For everything else (guiding questions, follow-ups, gentle nudges, walking through computations), reply in plain markdown — no tool call.

Be warm, curious, and patient. Prefer questions over assertions.`;

/** Django parity, verbatim (`_build_current_prompt`,
 *  apps/llm/src/llm/services.py:367): "Please respond as an AI tutor
 *  helping the student with this section. Guide them without giving away
 *  the complete answer." Django re-injects this into every per-turn user
 *  message; here it's assembled once into the system prompt instead (see
 *  the cross-cutting invariant on prompt-template pinning above) -- the
 *  pedagogical contract is what's preserved verbatim, not the delivery
 *  mechanism. Written scope-agnostic ("the student", not "this section")
 *  so the same sentence serves both section- and tutor-kind conversations. */
export const TUTOR_GUARDRAIL =
  "Respond as an AI tutor helping the student. Guide them without giving away the complete answer.";

export interface ResolvedPromptTemplate {
  /** Null when nothing was found at any scope (DEFAULT_SYSTEM_PROMPT was
   *  used) -- there is no real template row to pin. */
  id: string | null;
  content: string;
  version: number | null;
}

function toResolved(row: { id: string; content: string; version: number }): ResolvedPromptTemplate {
  return { id: row.id, content: row.content, version: row.version };
}

/** One prompt_templates row by id, but ONLY if still active -- an override
 *  FK (sections.promptTemplateId / homeworks.promptTemplateId) pointing at
 *  a row someone has since deactivated is treated as no override, not as a
 *  hard error; resolution falls through to the next scope level. */
async function fetchActiveTemplateById(db: Db, id: string): Promise<ResolvedPromptTemplate | null> {
  const [row] = await db
    .select({ id: promptTemplates.id, content: promptTemplates.content, version: promptTemplates.version })
    .from(promptTemplates)
    .where(and(eq(promptTemplates.id, id), eq(promptTemplates.isActive, true)));
  return row ? toResolved(row) : null;
}

/** Walks section -> homework -> course -> org -> built-in fallback, per the
 *  resolution order documented on promptTemplates itself
 *  (db/schema/content.ts). `sectionId` is null for tutor-kind conversations
 *  (no section to check overrides against; homework-level resolution is
 *  only ever reached via a section, matching the schema -- tutor
 *  conversations aren't linked to a specific homework).
 *
 *  Org scoping (#30 cross-cutting invariant): every level's query is scoped
 *  to `orgScope`/`courseScope`, both of which the caller must have already
 *  verified belong to the requester (mint via courseScopeFromAuthContext,
 *  never from unvalidated request input) -- this function does not
 *  itself re-check membership. */
export async function resolvePromptTemplate(
  db: Db,
  orgScope: OrgScope,
  courseScope: CourseScope,
  sectionId: string | null,
): Promise<ResolvedPromptTemplate> {
  if (sectionId) {
    const [section] = await db
      .select({ promptTemplateId: sections.promptTemplateId, homeworkId: sections.homeworkId })
      .from(sections)
      .where(eq(sections.id, sectionId));

    if (section?.promptTemplateId) {
      const fromSection = await fetchActiveTemplateById(db, section.promptTemplateId);
      if (fromSection) return fromSection;
    }

    if (section?.homeworkId) {
      const [homework] = await db
        .select({ promptTemplateId: homeworks.promptTemplateId })
        .from(homeworks)
        .where(eq(homeworks.id, section.homeworkId));
      if (homework?.promptTemplateId) {
        const fromHomework = await fetchActiveTemplateById(db, homework.promptTemplateId);
        if (fromHomework) return fromHomework;
      }
    }
  }

  const [courseTemplate] = await db
    .select({ id: promptTemplates.id, content: promptTemplates.content, version: promptTemplates.version })
    .from(promptTemplates)
    .where(and(eq(promptTemplates.scopeCourseId, courseScope), eq(promptTemplates.isActive, true)));
  if (courseTemplate) return toResolved(courseTemplate);

  const [orgTemplate] = await db
    .select({ id: promptTemplates.id, content: promptTemplates.content, version: promptTemplates.version })
    .from(promptTemplates)
    .where(and(eq(promptTemplates.scopeOrganizationId, orgScope), eq(promptTemplates.isActive, true)));
  if (orgTemplate) return toResolved(orgTemplate);

  return { id: null, content: DEFAULT_SYSTEM_PROMPT, version: null };
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
}

/** homework title + section title/content for assembleSystemPrompt's
 *  `section` parameter -- deliberately selects ONLY sections.content
 *  (the problem statement), never anything from section_solutions (a
 *  separate 1:1 table this function does not even join against). Course-
 *  scoped so a conversation's own courseId acts as the tenancy check;
 *  returns null for a sectionId that doesn't resolve within that scope
 *  (deleted section, cross-course id) rather than throwing -- chat.ts
 *  treats that as "build the prompt without section context" rather than
 *  failing the whole turn over stale section metadata. */
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
    })
    .from(sections)
    .innerJoin(homeworks, eq(sections.homeworkId, homeworks.id))
    .where(and(eq(sections.id, sectionId), eq(homeworks.courseId, courseScope)));
  return row ?? null;
}

/** Pure composition: template content + (optional) section context + the
 *  tutor guardrail -> one system-prompt string. No db access, no I/O --
 *  the whole point of extracting this from resolvePromptTemplate is that
 *  it's trivially snapshot-testable (#25's own ask).
 *
 *  Section content is wrapped in an XML-style delimiter per the issue's own
 *  pitfall guidance: section.content is instructor-authored but still
 *  untrusted-as-instructions input from the model's point of view, so it's
 *  fenced rather than interpolated bare into the surrounding prompt. */
export function assembleSystemPrompt(templateContent: string, section?: PromptSectionContext): string {
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
  parts.push(TUTOR_GUARDRAIL);
  return parts.join("\n\n");
}
