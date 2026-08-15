import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { promptTemplates } from "../../db/schema";
import type { CourseScope } from "./scope";
import { runAtomically, type BatchStatement } from "./atomic";

/* --------------------------------------------------------------------------
   #317 review, #325 ("no write path"): resolvePromptTemplate (lib/prompts.ts)
   walks all four prompt_templates scopes, but the only writer anywhere in
   the repo was scripts/seed.ts -- onboarding a project's own pedagogy meant
   hand-written SQL per environment. This is the first real writer, scoped
   to the course level: the level a CDI project's own instructor can
   actually reach without an org-admin surface (org/homework/section-level
   CRUD would need their own instructor-facing entry points; not built here,
   same reasoning as #325's own requirement list only naming course-level).
   -------------------------------------------------------------------------- */

export interface CourseScopedPromptTemplate {
  id: string;
  content: string;
  version: number;
  composeWithParent: boolean;
  updatedAt: Date;
}

/** The course's own active prompt_templates row, if any. Used both to
 *  answer the instructor-facing GET (prefill the edit form) and internally
 *  by upsertCourseScopedPromptTemplate to decide create-vs-version-bump. */
export async function getCourseScopedPromptTemplate(
  db: Db,
  courseScope: CourseScope,
): Promise<CourseScopedPromptTemplate | null> {
  const [row] = await db
    .select({
      id: promptTemplates.id,
      content: promptTemplates.content,
      version: promptTemplates.version,
      composeWithParent: promptTemplates.composeWithParent,
      updatedAt: promptTemplates.updatedAt,
    })
    .from(promptTemplates)
    .where(and(eq(promptTemplates.scopeCourseId, courseScope), eq(promptTemplates.isActive, true)));
  return row ?? null;
}

/** Creates the course's first scoped template, or -- if one is already
 *  active -- versions it: a new row becomes active and points its
 *  previous_version_id back at the old one, which is deactivated in the
 *  SAME atomic group. The scope_course_id partial unique index (#324)
 *  permits only one active row per course, so the old row must stop being
 *  active in the same write the new one starts, or the insert itself fails
 *  the constraint -- runAtomically (repositories/atomic.ts) is what makes
 *  "deactivate old, insert new" one indivisible write on both drivers this
 *  repo runs on. Conversations already pinned to the old version (see
 *  lib/prompts.ts's module doc comment on pinning) keep resolving it via
 *  getPinnedPromptTemplateContent, which reads by id regardless of
 *  isActive -- deactivating it here does not retroactively change what an
 *  in-progress conversation says. */
export async function upsertCourseScopedPromptTemplate(
  db: Db,
  courseScope: CourseScope,
  input: { content: string; composeWithParent: boolean },
): Promise<{ id: string; version: number }> {
  const current = await getCourseScopedPromptTemplate(db, courseScope);
  const newId = crypto.randomUUID();
  const newVersion = (current?.version ?? 0) + 1;

  await runAtomically(db, (t) => {
    const statements: BatchStatement[] = [];
    if (current) {
      statements.push(
        t.update(promptTemplates).set({ isActive: false }).where(eq(promptTemplates.id, current.id)),
      );
    }
    statements.push(
      t.insert(promptTemplates).values({
        id: newId,
        scopeCourseId: courseScope,
        content: input.content,
        composeWithParent: input.composeWithParent,
        version: newVersion,
        previousVersionId: current?.id ?? null,
        isActive: true,
      }),
    );
    return statements;
  });

  return { id: newId, version: newVersion };
}

/** Deactivates the course's active scoped template, if any -- resolution
 *  falls through to the org level (or DEFAULT_SYSTEM_PROMPT) on the very
 *  next turn, the same fallthrough as any deactivated row at any scope
 *  (lib/prompts.ts's resolvePromptTemplate). Idempotent: a no-op UPDATE
 *  when nothing is currently active. */
export async function deactivateCourseScopedPromptTemplate(db: Db, courseScope: CourseScope): Promise<void> {
  await db
    .update(promptTemplates)
    .set({ isActive: false })
    .where(and(eq(promptTemplates.scopeCourseId, courseScope), eq(promptTemplates.isActive, true)));
}
