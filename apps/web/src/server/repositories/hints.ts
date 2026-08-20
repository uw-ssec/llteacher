import { and, count, desc, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { hintBudgets, hintEvents, homeworks, sections } from "../../db/schema";
import type { CourseScope, OrgScope } from "./scope";

/* --------------------------------------------------------------------------
   #80: hint semantics -- what counts as a "hint" and how it's persisted.

   A hint is an explicit student action (the "Give me a hint" trigger,
   Composer.tsx) that the server deterministically grants or denies BEFORE
   the model is ever called (see chat.ts's own use of recordHintRequest,
   inserted into chatHandler right after the per-conversation turn lock is
   acquired) -- never a heuristic classification of the tutor's free-text
   reply after the fact. That's what makes a hintEvents row "deterministic
   and countable," per the issue's own stated preference.

   Budget model (this task's ruling, recorded here and in the PR report):
   per (section, student), NOT a shared per-section pool. A shared pool
   would let one student's hint use exhaust the budget for the whole class
   -- nothing else in this schema's per-student state (submissions,
   section_answers, homework_progress_widget_responses) shares state across
   students that way, and there is no indication anywhere in this codebase's
   existing patterns that a shared-across-students resource was intended.

   Unlimited by default: a section with no hint_budgets row (the only state
   today -- nothing seeds this table yet) has no cap. maxHints exists so a
   future config change is data-only, not a schema migration -- see
   hintBudgets' own doc comment (db/schema/content.ts).
   -------------------------------------------------------------------------- */

// #80 Pitfalls: "Double-submit on UI button ... Idempotency key (e.g.
// (conversationId, sectionId, createdAt) tuple) deduplicates server-side
// within a 2s window." A duplicate request (a network retry, or a rapid
// double-click that raced past Composer's own client-side 1s suppression)
// arriving within this many ms of the student's last GRANTED event for the
// same conversation is treated as the same request: no new event, the same
// result is returned. A DENIED request needs no such handling -- it never
// writes a row, so repeating it is already idempotent by construction (same
// inputs, same "budget_exceeded" answer, no side effect either time).
export const HINT_IDEMPOTENCY_WINDOW_MS = 2_000;

export interface HintRequestResult {
  status: "hint_provided" | "budget_exceeded";
  /** null when the section has no configured limit (unlimited). */
  remainingHints: number | null;
  /** True when this call reused a very recent prior GRANTED event instead
   *  of recording a new one -- see HINT_IDEMPOTENCY_WINDOW_MS above. */
  deduped: boolean;
}

/** The per-(section, student) usage count this task's budget check (and the
 *  Sidebar's real-state hint count, replacing the #20 fixture) both read.
 *  Deliberately NOT scoped by conversationId: a student can restart a
 *  section's conversation (#27) and hint usage must still be tracked
 *  against the section as a whole, not reset by a fresh conversation row. */
export async function getHintCount(db: Db, sectionId: string, studentId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(hintEvents)
    .where(and(eq(hintEvents.sectionId, sectionId), eq(hintEvents.studentId, studentId)));
  return row?.n ?? 0;
}

/** null = unlimited -- both "no row for this section" (today's only real
 *  state) and "a row exists with an explicit NULL maxHints" (reachable once
 *  an instructor-facing editor for this table exists, not built by this
 *  task) mean the same thing to every caller. */
export async function getSectionHintLimit(db: Db, sectionId: string): Promise<number | null> {
  const [row] = await db.select({ maxHints: hintBudgets.maxHints }).from(hintBudgets).where(eq(hintBudgets.sectionId, sectionId));
  return row?.maxHints ?? null;
}

export interface SectionHintStatus {
  count: number;
  /** null = unlimited. */
  limit: number | null;
  /** null = unlimited. */
  remaining: number | null;
}

/** Course-tenancy-verified read, for the GET route that drives Sidebar's
 *  real hint count (replacing the #20 fixture). Unlike recordHintRequest
 *  above -- called only from chat.ts, where sectionId already comes from an
 *  owned, resolved conversation -- this is reachable directly from a URL
 *  path param, so it must prove sectionId actually belongs to courseScope
 *  before returning anything, the same "verify via the real parent chain"
 *  rule getSectionAnswer (sectionAnswers.ts) already follows. Returns null
 *  for a sectionId that doesn't resolve within scope, mirroring
 *  getSectionPromptContext's own "null, not a throw" convention for the
 *  same situation. */
export async function getSectionHintStatus(
  db: Db,
  courseScope: CourseScope,
  sectionId: string,
  studentId: string,
): Promise<SectionHintStatus | null> {
  const [section] = await db
    .select({ id: sections.id })
    .from(sections)
    .innerJoin(homeworks, eq(sections.homeworkId, homeworks.id))
    .where(and(eq(sections.id, sectionId), eq(homeworks.courseId, courseScope)));
  if (!section) return null;

  const [usedCount, limit] = await Promise.all([
    getHintCount(db, sectionId, studentId),
    getSectionHintLimit(db, sectionId),
  ]);
  return {
    count: usedCount,
    limit,
    remaining: limit === null ? null : Math.max(0, limit - usedCount),
  };
}

/** Grants or denies one "give me a hint" request, deterministically:
 *    1. Idempotency window -- a very recent GRANTED event for this exact
 *       (conversation, student) is replayed, not duplicated.
 *    2. Budget check -- (section, student) usage vs. the section's
 *       configured limit (null = unlimited, always granted).
 *    3. Insert -- only on a genuine grant; a denial writes nothing.
 *
 *  `now` is an explicit parameter (matching reserveRateLimitSlot's own
 *  convention, repositories/rateLimits.ts) so the idempotency window is
 *  testable without a real sleep or faking the DB server's clock.
 *
 *  #80: NOT wrapped in a transaction/lock of its own -- two genuinely
 *  concurrent requests for the same (section, student) could both pass the
 *  budget check before either inserts (a real, accepted race). This is a
 *  pedagogical soft-limit, not a security boundary, and chat.ts's own
 *  per-conversation turn lock already serializes the dominant real-world
 *  case (a single student's own browser tab, one turn at a time); an
 *  unusual multi-tab/network-retry race can over-grant by a small margin.
 *  Documented, not fixed, for the same "accepted simplification" reasons
 *  the submissions table's own uniqueness-cap comment (db/schema/runtime.ts)
 *  gives for its own analogous gap. */
export async function recordHintRequest(
  db: Db,
  scope: OrgScope,
  input: {
    conversationId: string;
    sectionId: string;
    studentId: string;
    promptTemplateId: string | null;
  },
  now: Date = new Date(),
): Promise<HintRequestResult> {
  const [mostRecent] = await db
    .select({ createdAt: hintEvents.createdAt })
    .from(hintEvents)
    .where(and(eq(hintEvents.conversationId, input.conversationId), eq(hintEvents.studentId, input.studentId)))
    .orderBy(desc(hintEvents.createdAt))
    .limit(1);

  const limit = await getSectionHintLimit(db, input.sectionId);

  // Only a GRANTED request ever leaves a row (see the function's own doc
  // comment above), so `mostRecent` here can only represent a prior grant --
  // replaying "hint_provided" is always the correct dedup outcome.
  if (mostRecent && now.getTime() - mostRecent.createdAt.getTime() < HINT_IDEMPOTENCY_WINDOW_MS) {
    const countSoFar = await getHintCount(db, input.sectionId, input.studentId);
    return {
      status: "hint_provided",
      remainingHints: limit === null ? null : Math.max(0, limit - countSoFar),
      deduped: true,
    };
  }

  const currentCount = await getHintCount(db, input.sectionId, input.studentId);
  if (limit !== null && currentCount >= limit) {
    return { status: "budget_exceeded", remainingHints: 0, deduped: false };
  }

  await db.insert(hintEvents).values({
    conversationId: input.conversationId,
    sectionId: input.sectionId,
    studentId: input.studentId,
    organizationId: scope,
    promptTemplateId: input.promptTemplateId,
    isLimitReached: limit !== null && currentCount + 1 >= limit,
    createdAt: now,
  });

  return {
    status: "hint_provided",
    remainingHints: limit === null ? null : Math.max(0, limit - (currentCount + 1)),
    deduped: false,
  };
}
