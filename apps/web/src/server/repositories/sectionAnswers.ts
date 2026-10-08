import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../../db/client";
import { sections, homeworks, courses, courseMemberships, sectionAnswers } from "../../db/schema";
import type { OrgScope, CourseScope } from "./scope";
import { deriveHomeworkStatus, isHomeworkHidden } from "./homeworks";

/* upsertSectionAnswer's refusals. Typed (they were plain Errors) so the route
   can translate exactly these and let anything else -- a dropped connection
   -- reach the 503 path instead of a bare catch reporting it as a refusal.
   Kept distinct here; the route decides what to collapse. */

/** The section is absent, in another org, or the caller holds no live
 *  student membership in its course. */
export class SectionAnswerSectionNotFoundError extends Error {
  readonly _tag = "SectionAnswerSectionNotFoundError" as const;
  constructor() {
    super("Section not found in this org scope");
    this.name = "SectionAnswerSectionNotFoundError";
  }
}

/** The section is a conversation section, not a non_interactive one. */
export class SectionNotAnswerableError extends Error {
  readonly _tag = "SectionNotAnswerableError" as const;
  constructor() {
    super("Section does not accept a direct answer");
    this.name = "SectionNotAnswerableError";
  }
}

/** #177: the parent homework is hidden or past its expiry. */
export class SectionAnswerHomeworkClosedError extends Error {
  readonly _tag = "SectionAnswerHomeworkClosedError" as const;
  constructor() {
    super("Homework is hidden or expired");
    this.name = "SectionAnswerHomeworkClosedError";
  }
}

/** #164: verifies (via the real parent chain, never trusting the caller)
 *  that sectionId resolves to a non_interactive section within scope's org
 *  before writing -- same rationale as createSubmission/submitSection's
 *  ownership-verification-via-join pattern (repositories/submissions.ts).
 *  Upsert-on-revise, not a history table: see Resolved Design Decision 19
 *  in the M3 plan. #175: also requires a non-dropped student membership in
 *  the section's own course -- org membership alone let a student in course
 *  A write into course B's data, since this row has no prior owned parent
 *  (unlike submitSection, where conversation ownership already narrows it).
 *  #177: also rejects once the parent homework derives to hidden. */
export async function upsertSectionAnswer(db: Db, scope: OrgScope, sectionId: string, userId: string, content: string) {
  const [owned] = await db
    .select({
      id: sections.id,
      type: sections.type,
      isHidden: homeworks.isHidden,
      expiresAt: homeworks.expiresAt,
    })
    .from(sections)
    .innerJoin(homeworks, eq(sections.homeworkId, homeworks.id))
    .innerJoin(courses, eq(homeworks.courseId, courses.id))
    .innerJoin(
      courseMemberships,
      and(
        eq(courseMemberships.courseId, courses.id),
        eq(courseMemberships.userId, userId),
        eq(courseMemberships.role, "student"),
        isNull(courseMemberships.droppedAt),
      ),
    )
    .where(and(eq(sections.id, sectionId), eq(courses.organizationId, scope)));
  if (!owned) {
    throw new SectionAnswerSectionNotFoundError();
  }
  if (owned.type !== "non_interactive") {
    throw new SectionNotAnswerableError();
  }
  if (isHomeworkHidden(owned)) {
    throw new SectionAnswerHomeworkClosedError();
  }

  const [existing] = await db
    .select({ id: sectionAnswers.id })
    .from(sectionAnswers)
    .where(and(eq(sectionAnswers.sectionId, sectionId), eq(sectionAnswers.userId, userId)));
  if (existing) {
    const [updated] = await db
      .update(sectionAnswers)
      .set({ content, updatedAt: new Date() })
      .where(eq(sectionAnswers.id, existing.id))
      .returning();
    return updated!;
  }

  const [created] = await db
    .insert(sectionAnswers)
    .values({ sectionId, userId, organizationId: scope, content })
    .returning();
  return created!;
}

/** #174: takes a CourseScope, not an OrgScope -- the caller (an instructor)
 *  is authorized on courseId, so the query must be constrained by the same
 *  key, not widened to the whole org. Without the sections/homeworks join
 *  below, a section belonging to a *different* course in the same org was
 *  reachable through this route once its instructor lost course access. */
export async function getSectionAnswer(db: Db, scope: CourseScope, sectionId: string, userId: string) {
  const [found] = await db
    .select({
      id: sectionAnswers.id,
      sectionId: sectionAnswers.sectionId,
      userId: sectionAnswers.userId,
      content: sectionAnswers.content,
      submittedAt: sectionAnswers.submittedAt,
      updatedAt: sectionAnswers.updatedAt,
      // #172 audit (SEC-001): the parent homework's release state, so the
      // route can apply the same unreleased-content gate the detail route
      // applies. The join to `homeworks` already exists for course scoping.
      dueDate: homeworks.dueDate,
      publishedAt: homeworks.publishedAt,
      releasedAt: homeworks.releasedAt,
      isHidden: homeworks.isHidden,
      expiresAt: homeworks.expiresAt,
    })
    .from(sectionAnswers)
    .innerJoin(sections, eq(sectionAnswers.sectionId, sections.id))
    .innerJoin(homeworks, eq(sections.homeworkId, homeworks.id))
    .where(
      and(
        eq(sectionAnswers.sectionId, sectionId),
        eq(sectionAnswers.userId, userId),
        eq(homeworks.courseId, scope),
      ),
    );
  if (!found) return null;
  // Derive here rather than handing the route five raw columns to reassemble:
  // one field, and the route cannot get the derivation subtly wrong.
  const { dueDate, publishedAt, releasedAt, isHidden, expiresAt, ...answer } = found;
  return {
    ...answer,
    homeworkStatus: deriveHomeworkStatus({ dueDate, publishedAt, releasedAt, isHidden, expiresAt }),
  };
}
