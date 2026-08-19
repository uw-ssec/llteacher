import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { homeworks, sections, sectionSolutions, conversations, homeworkProgressWidgets } from "../../db/schema";
import type { CourseScope } from "./scope";
import {
  planSectionDiff,
  type ExistingSection,
  type IncomingSection,
  type SectionUpdatePlan,
  type SectionType,
} from "./sections";
import { planWidgetDiff, type ExistingWidget, type IncomingWidget } from "./progressWidgets";
import type { HomeworkListItemResponse } from "../../shared/types";

export async function listHomeworksForCourse(db: Db, scope: CourseScope): Promise<HomeworkListItemResponse[]> {
  const rows = await db.query.homeworks.findMany({
    where: eq(homeworks.courseId, scope),
    orderBy: (h, { asc }) => [asc(h.createdAt)],
  });
  if (rows.length === 0) return [];
  const counts = await db
    .select({ homeworkId: sections.homeworkId, count: sql<number>`count(*)::int` })
    .from(sections)
    .where(inArray(sections.homeworkId, rows.map((h) => h.id)))
    .groupBy(sections.homeworkId);
  const countByHomeworkId = new Map(counts.map((c) => [c.homeworkId, c.count]));
  return rows.map((hw) => ({
    id: hw.id,
    title: hw.title,
    description: hw.description,
    dueDate: hw.dueDate.toISOString(),
    llmConfigId: hw.llmConfigId,
    status: deriveHomeworkStatus(hw),
    isHidden: hw.isHidden,
    expiresAt: hw.expiresAt?.toISOString() ?? null,
    sectionCount: countByHomeworkId.get(hw.id) ?? 0,
  }));
}

export async function createHomework(
  db: Db,
  scope: CourseScope,
  input: { createdById: string; title: string; description: string; dueDate: Date },
) {
  const [created] = await db
    .insert(homeworks)
    .values({ courseId: scope, ...input })
    .returning({ id: homeworks.id });
  return created;
}

export type HomeworkStatus = "draft" | "scheduled" | "active" | "past_due" | "hidden" | "archived";

/** Pure function of (dueDate, publishedAt, releasedAt, isHidden, expiresAt)
 *  -- no DB, no `now()` parameter needed by callers (uses the real clock;
 *  tests pass fixed dates through the inputs instead of mocking time).
 *
 *  "archived" is a 5th status apps/admin's pre-M3 fixture typing already
 *  carried (see apps/admin/src/client/lib/fixtures.ts's Homework.status).
 *  This function still never returns it -- the type is kept (not narrowed)
 *  so a future feature can add the missing input it would need, without
 *  every consumer's exhaustiveness check breaking. #166 (M3, Resolved
 *  Design Decision 17) decided "hidden" and "archived" are distinct
 *  concepts: "archived" has no defined semantics anywhere yet (it might
 *  later mean something stronger than invisibility -- read-only, term-
 *  ended, non-editable), so it stays reserved and unreachable rather than
 *  being repurposed for #166's manual-hide/auto-expiry feature. */
/** #177: extracted so the write-side gate (upsertSectionAnswer,
 *  submitWidgetResponse, submitSection) checks the exact same condition as
 *  deriveHomeworkStatus's own hidden branch, rather than a second
 *  hand-copied expression that could drift out of sync with it. */
export function isHomeworkHidden(hw: { isHidden: boolean; expiresAt: Date | null }): boolean {
  return hw.isHidden || (hw.expiresAt !== null && hw.expiresAt.getTime() <= Date.now());
}

/** Statuses that mean "the instructor has not released this to students".
 *
 *  #172 audit (SEC-001): the three statuses were spelled out inline at each
 *  gate, and the two grading routes widened to TAs were given no gate at
 *  all -- so a TA denied `can_view_drafts` could still read a hidden
 *  homework's title, due date and section titles through the submissions
 *  dashboard, content the detail route explicitly 404s them for.
 *
 *  #197 (#172 re-audit, MNT-020): the five gates that key on release state
 *  are the instructor list route, the detail route, the submissions
 *  dashboard, the section-answer read, and the student list in
 *  studentHomeworks.ts. An earlier version of this comment said "every
 *  route" and "the four gates" while the student list still spelled the
 *  triple out inline -- so the one gate protecting students was the one the
 *  comment had quietly written out of the count. Naming them is the point:
 *  a reader adding a status can check the list rather than trust a number. */
const UNRELEASED_STATUSES: ReadonlySet<HomeworkStatus> = new Set([
  "draft",
  "scheduled",
  "hidden",
]);

export function isUnreleased(status: HomeworkStatus): boolean {
  return UNRELEASED_STATUSES.has(status);
}

export function deriveHomeworkStatus(hw: {
  dueDate: Date;
  publishedAt: Date | null;
  releasedAt: Date | null;
  isHidden: boolean;
  expiresAt: Date | null;
}): HomeworkStatus {
  const now = new Date();
  // #166: is_hidden/expires_at take precedence over every other state,
  // including draft -- matches the reference app's design (access is one
  // source of truth, the enum is cosmetic). Checked first so callers can
  // filter on deriveHomeworkStatus's result alone, never a raw column.
  if (isHomeworkHidden(hw)) {
    return "hidden";
  }
  if (!hw.publishedAt) return "draft";
  if (hw.releasedAt && hw.releasedAt.getTime() > now.getTime()) return "scheduled";
  return hw.dueDate.getTime() > now.getTime() ? "active" : "past_due";
}

export async function getHomeworkById(db: Db, scope: CourseScope, id: string) {
  const homework = await db.query.homeworks.findFirst({
    where: and(eq(homeworks.id, id), eq(homeworks.courseId, scope)),
  });
  if (!homework) return null;

  const sectionRows = await db.query.sections.findMany({
    where: eq(sections.homeworkId, id),
    with: { solution: true },
    orderBy: (s, { asc }) => [asc(s.order)],
  });

  // #165: same two-query style as the sections fetch above, not a nested
  // `with` (Decision 10's bytea-corruption finding is about encrypted
  // columns specifically, not a blanket ban -- but this file's existing
  // convention is already flat fetches for every homework sub-resource).
  const widgetRows = await db.query.homeworkProgressWidgets.findMany({
    where: eq(homeworkProgressWidgets.homeworkId, id),
    orderBy: (w, { asc }) => [asc(w.order)],
  });

  return { homework, sections: sectionRows, widgets: widgetRows };
}

export async function deleteHomework(db: Db, scope: CourseScope, id: string) {
  // sections/sectionSolutions/conversations/messages/submissions all cascade
  // from homeworks.id -> sections.homeworkId -> ... (see Resolved Design
  // Decision 3), and (#317 review, #341) llm_call_logs' conversation_id/
  // message_id FKs are ON DELETE SET NULL (migration 0036, matching
  // llm_config_id's existing pattern on the same table) -- the cost/
  // telemetry rows survive, just detached, rather than blocking this
  // delete with a generic 503 the moment a section has a single chat turn
  // logged against it. A single delete on this scoped row is sufficient.
  //
  // #353: grades.submission_id keeps its own RESTRICT (pre-existing,
  // narrower: only blocks a homework with a GRADED submission, not any
  // chat activity -- see docs/architecture/multi-tenant-data-model.md
  // §3.5 point 5) -- that path is NOT covered by the SET NULL fix above,
  // and can still surface as a 503 here.
  const [deleted] = await db
    .delete(homeworks)
    .where(and(eq(homeworks.id, id), eq(homeworks.courseId, scope)))
    .returning({ id: homeworks.id });
  return deleted ?? null;
}

/** Cheap existence check (#94) for the unpublish-with-activity warning:
 *  does any conversation exist for any of this homework's sections? An
 *  EXISTS-shaped `limit(1)` query, not a full fetch -- the route layer only
 *  needs a boolean, not the rows themselves. */
export async function homeworkHasStudentActivity(db: Db, homeworkId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .innerJoin(sections, eq(conversations.sectionId, sections.id))
    .where(eq(sections.homeworkId, homeworkId))
    .limit(1);
  return !!row;
}

/** #166: is_hidden/expires_at, independent of publish state -- an instructor
 *  can pull a published homework from view without unpublishing it.
 *  expiresAt is `undefined` (omit the field entirely) to leave it
 *  unchanged, `null` to explicitly clear it -- mirrors updateHomework's
 *  `!== undefined` convention elsewhere in this file. */
export async function updateHomeworkHideState(
  db: Db,
  scope: CourseScope,
  id: string,
  input: { isHidden: boolean; expiresAt?: Date | null },
) {
  const [updated] = await db
    .update(homeworks)
    .set({
      isHidden: input.isHidden,
      ...(input.expiresAt !== undefined && { expiresAt: input.expiresAt }),
      updatedAt: new Date(),
    })
    .where(and(eq(homeworks.id, id), eq(homeworks.courseId, scope)))
    .returning();
  return updated ?? null;
}

export async function updateHomeworkPublishState(
  db: Db,
  scope: CourseScope,
  id: string,
  input: { publish: boolean; releasedAt?: Date },
) {
  const [updated] = await db
    .update(homeworks)
    .set({
      publishedAt: input.publish ? new Date() : null,
      releasedAt: input.publish ? (input.releasedAt ?? new Date()) : null,
      updatedAt: new Date(),
    })
    .where(and(eq(homeworks.id, id), eq(homeworks.courseId, scope)))
    .returning();
  return updated ?? null;
}

export interface HomeworkUpdateFields {
  title?: string;
  description?: string;
  dueDate?: Date;
  llmConfigId?: string | null;
  sections?: IncomingSection[];
  widgets?: IncomingWidget[];
}

type BatchStatement = Parameters<Db["batch"]>[0][number];

/** Order-slot-collision-free reordering. sections_homework_order_uq is a
 *  plain (non-deferrable) unique index -- Postgres checks it immediately
 *  after each statement, so naively applying every reordered section's
 *  UPDATE in plan order can collide mid-batch (e.g. a straight swap, or a
 *  range shift when a section is inserted in the middle). This resolves the
 *  moves in dependency order instead: repeatedly apply any pending move
 *  whose target slot is currently free (freeing one slot often unblocks
 *  another, so plain shifts/insertions resolve in zero scratch bumps), and
 *  only bump a section to a scratch order value when a genuine cycle
 *  remains (every remaining move's target is held by another remaining
 *  move). See Resolved Design Decision 7 for the full reasoning and a
 *  hand-traced example of both the zero-bump and one-bump cases. */
async function resolveSectionWrites(
  existingSections: ExistingSection[],
  deletedIds: Set<string>,
  plan: ReturnType<typeof planSectionDiff>,
  pushSectionInsert: (id: string, order: number, title: string, content: string, type: SectionType) => Promise<void> | void,
  pushSectionUpdate: (id: string, order: number, title: string, content: string, type: SectionType) => Promise<void> | void,
  pushSolutionWrites: (sectionId: string, action: SectionUpdatePlan["solutionAction"], content: string | undefined) => Promise<void> | void,
) {
  type PendingWrite =
    | { kind: "update"; id: string; targetOrder: number; title: string; content: string; type: SectionType; solutionAction: SectionUpdatePlan["solutionAction"]; solutionContent?: string }
    | { kind: "create"; id: string; targetOrder: number; title: string; content: string; type: SectionType; solutionContent?: string };

  const existingById = new Map(existingSections.map((s) => [s.id, s]));
  const livePosition = new Map<string, number>();
  const currentOccupant = new Map<number, string>();
  for (const s of existingSections) {
    if (!deletedIds.has(s.id)) {
      livePosition.set(s.id, s.order);
      currentOccupant.set(s.order, s.id);
    }
  }

  const pending: PendingWrite[] = [];
  for (const upd of plan.toUpdate) {
    const prior = existingById.get(upd.id)!;
    if (prior.order === upd.order) {
      // No collision possible -- write it immediately, it never competes
      // for a slot with anything else in this diff.
      await pushSectionUpdate(upd.id, upd.order, upd.title, upd.content, upd.type);
      await pushSolutionWrites(upd.id, upd.solutionAction, upd.solutionContent);
    } else {
      pending.push({ kind: "update", id: upd.id, targetOrder: upd.order, title: upd.title, content: upd.content, type: upd.type, solutionAction: upd.solutionAction, solutionContent: upd.solutionContent });
    }
  }
  for (const create of plan.toCreate) {
    pending.push({ kind: "create", id: crypto.randomUUID(), targetOrder: create.order, title: create.title, content: create.content, type: create.type, solutionContent: create.solutionContent });
  }

  const placed = new Set<PendingWrite>();

  async function apply(write: PendingWrite) {
    if (write.kind === "create") {
      await pushSectionInsert(write.id, write.targetOrder, write.title, write.content, write.type);
      if (write.solutionContent !== undefined) {
        await pushSolutionWrites(write.id, "create", write.solutionContent);
      }
    } else {
      await pushSectionUpdate(write.id, write.targetOrder, write.title, write.content, write.type);
      await pushSolutionWrites(write.id, write.solutionAction, write.solutionContent);
      const prevOrder = livePosition.get(write.id);
      if (prevOrder !== undefined) currentOccupant.delete(prevOrder);
    }
    currentOccupant.set(write.targetOrder, write.id);
    livePosition.set(write.id, write.targetOrder);
    placed.add(write);
  }

  async function runPasses() {
    let progress = true;
    while (progress) {
      progress = false;
      for (const write of pending) {
        if (placed.has(write)) continue;
        if (!currentOccupant.has(write.targetOrder)) {
          await apply(write);
          progress = true;
        }
      }
    }
  }

  await runPasses();

  while (pending.some((w) => !placed.has(w))) {
    const stillOpen = pending.filter((w) => !placed.has(w));
    const reserved = new Set<number>([...currentOccupant.keys(), ...stillOpen.map((w) => w.targetOrder)]);
    let scratch: number | undefined;
    for (let candidate = 1; candidate <= 20; candidate++) {
      if (!reserved.has(candidate)) { scratch = candidate; break; }
    }
    if (scratch === undefined) {
      throw new Error(
        "cannot resolve section reorder: no free order slot to stage a cyclic move -- reorder in two smaller steps",
      );
    }
    // Every still-open write at this point is necessarily an "update": a
    // brand-new create's target can only ever be blocked by an existing
    // section that hasn't moved yet, and that section (if it too has a
    // pending move) gets unblocked by this same bump-and-retry loop before
    // a create could ever be the thing left stuck.
    const stuck = stillOpen.find((w): w is Extract<PendingWrite, { kind: "update" }> => w.kind === "update")!;
    const stuckCurrentOrder = livePosition.get(stuck.id)!;
    // Parked at a scratch slot, not the final write -- apply() (via
    // runPasses() below) writes the real target title/content/type once
    // the collision clears. Use the section's *current* type here, not
    // stuck.type (the target), to avoid writing a value that never gets
    // reconciled if this loop iterates again before apply() runs.
    await pushSectionUpdate(stuck.id, scratch, existingById.get(stuck.id)!.title, existingById.get(stuck.id)!.content, existingById.get(stuck.id)!.type);
    currentOccupant.delete(stuckCurrentOrder);
    currentOccupant.set(scratch, stuck.id);
    livePosition.set(stuck.id, scratch);
    await runPasses();
  }
}

/** #165: same pass-based-plus-scratch-bump technique as resolveSectionWrites
 *  above (Resolved Design Decision 7), sized down -- widgets carry no
 *  solution-equivalent sub-write, so there's no third callback and no
 *  solution bookkeeping. See Resolved Design Decision 25 for why this is a
 *  parallel implementation rather than a generalization of the section
 *  version. */
async function resolveWidgetWrites(
  existingWidgets: ExistingWidget[],
  deletedIds: Set<string>,
  plan: ReturnType<typeof planWidgetDiff>,
  pushWidgetInsert: (id: string, order: number, prePrompt: string, postPrompt: string) => Promise<void> | void,
  pushWidgetUpdate: (id: string, order: number, prePrompt: string, postPrompt: string) => Promise<void> | void,
) {
  type PendingWrite =
    | { kind: "update"; id: string; targetOrder: number; prePrompt: string; postPrompt: string }
    | { kind: "create"; id: string; targetOrder: number; prePrompt: string; postPrompt: string };

  const existingById = new Map(existingWidgets.map((w) => [w.id, w]));
  const livePosition = new Map<string, number>();
  const currentOccupant = new Map<number, string>();
  for (const w of existingWidgets) {
    if (!deletedIds.has(w.id)) {
      livePosition.set(w.id, w.order);
      currentOccupant.set(w.order, w.id);
    }
  }

  const pending: PendingWrite[] = [];
  for (const upd of plan.toUpdate) {
    const prior = existingById.get(upd.id)!;
    if (prior.order === upd.order) {
      await pushWidgetUpdate(upd.id, upd.order, upd.prePrompt, upd.postPrompt);
    } else {
      pending.push({ kind: "update", id: upd.id, targetOrder: upd.order, prePrompt: upd.prePrompt, postPrompt: upd.postPrompt });
    }
  }
  for (const create of plan.toCreate) {
    pending.push({ kind: "create", id: crypto.randomUUID(), targetOrder: create.order, prePrompt: create.prePrompt, postPrompt: create.postPrompt });
  }

  const placed = new Set<PendingWrite>();

  async function apply(write: PendingWrite) {
    if (write.kind === "create") {
      await pushWidgetInsert(write.id, write.targetOrder, write.prePrompt, write.postPrompt);
    } else {
      await pushWidgetUpdate(write.id, write.targetOrder, write.prePrompt, write.postPrompt);
      const prevOrder = livePosition.get(write.id);
      if (prevOrder !== undefined) currentOccupant.delete(prevOrder);
    }
    currentOccupant.set(write.targetOrder, write.id);
    livePosition.set(write.id, write.targetOrder);
    placed.add(write);
  }

  async function runPasses() {
    let progress = true;
    while (progress) {
      progress = false;
      for (const write of pending) {
        if (placed.has(write)) continue;
        if (!currentOccupant.has(write.targetOrder)) {
          await apply(write);
          progress = true;
        }
      }
    }
  }

  await runPasses();

  while (pending.some((w) => !placed.has(w))) {
    const stillOpen = pending.filter((w) => !placed.has(w));
    const reserved = new Set<number>([...currentOccupant.keys(), ...stillOpen.map((w) => w.targetOrder)]);
    let scratch: number | undefined;
    for (let candidate = 1; candidate <= 20; candidate++) {
      if (!reserved.has(candidate)) { scratch = candidate; break; }
    }
    if (scratch === undefined) {
      throw new Error(
        "cannot resolve widget reorder: no free order slot to stage a cyclic move -- reorder in two smaller steps",
      );
    }
    const stuck = stillOpen.find((w): w is Extract<PendingWrite, { kind: "update" }> => w.kind === "update")!;
    const stuckCurrentOrder = livePosition.get(stuck.id)!;
    await pushWidgetUpdate(stuck.id, scratch, existingById.get(stuck.id)!.prePrompt, existingById.get(stuck.id)!.postPrompt);
    currentOccupant.delete(stuckCurrentOrder);
    currentOccupant.set(scratch, stuck.id);
    livePosition.set(stuck.id, scratch);
    await runPasses();
  }
}

/** Applies planSectionDiff's plan (Task 2) atomically alongside any
 *  top-level homework field updates. Branches on driver capability at
 *  runtime (see Resolved Design Decision 6): production's neon-http driver
 *  supports `db.batch()` but not `db.transaction()`; the node-postgres
 *  driver real-DB tests use (`makeNodeDb`) is the mirror image --
 *  `db.transaction()` works, `db.batch` doesn't exist at runtime despite
 *  the shared `Db` type claiming it does. Feature-detect via
 *  `typeof db.batch === "function"` (a missing method is a TypeError at
 *  the call site, not something to try/catch). `resolveSectionWrites`'s
 *  ordering algorithm is identical either way -- only whether a resolved
 *  write defers into a batch array or executes immediately against `tx`
 *  differs, so real-DB tests exercise the same logic production runs.
 *  Returns null if `id` isn't found in `scope` (caller maps that to 404).
 *  Throws for constraint violations (duplicate/out-of-range order) and for
 *  the unresolvable-cycle edge case, both uncaught -- the route layer
 *  (Task 6) catches and maps those to a 422. */
export async function updateHomework(
  db: Db,
  scope: CourseScope,
  id: string,
  input: HomeworkUpdateFields,
) {
  const existingHomework = await db.query.homeworks.findFirst({
    where: and(eq(homeworks.id, id), eq(homeworks.courseId, scope)),
  });
  if (!existingHomework) return null;

  const topLevelFields = {
    ...(input.title !== undefined && { title: input.title }),
    ...(input.description !== undefined && { description: input.description }),
    ...(input.dueDate !== undefined && { dueDate: input.dueDate }),
    ...(input.llmConfigId !== undefined && { llmConfigId: input.llmConfigId }),
  };

  // Read-then-plan happens outside either write path -- it's a SELECT, not
  // a mutation, so there's nothing to keep atomic about it yet.
  let existingSections: ExistingSection[] = [];
  let plan: ReturnType<typeof planSectionDiff> | null = null;
  if (input.sections) {
    existingSections = (
      await db.query.sections.findMany({
        where: eq(sections.homeworkId, id),
        with: { solution: true },
      })
    ).map((s) => ({
      id: s.id,
      order: s.order,
      title: s.title,
      content: s.content,
      solutionId: s.solution?.id ?? null,
      type: s.type,
    }));
    plan = planSectionDiff(existingSections, input.sections);
  }

  // #165: an independent diff from sections' -- widgets and sections share
  // one atomic write (both write paths below) but neither reads the
  // other's plan.
  let existingWidgets: ExistingWidget[] = [];
  let widgetPlan: ReturnType<typeof planWidgetDiff> | null = null;
  if (input.widgets) {
    existingWidgets = await db.query.homeworkProgressWidgets.findMany({
      where: eq(homeworkProgressWidgets.homeworkId, id),
    });
    widgetPlan = planWidgetDiff(existingWidgets, input.widgets);
  }

  if (typeof db.batch === "function") {
    // Production path: neon-http. Collect query-builder objects (built
    // against `db`) and execute them all as one atomic HTTP round-trip.
    const statements: BatchStatement[] = [];
    if (Object.keys(topLevelFields).length > 0) {
      statements.push(db.update(homeworks).set({ ...topLevelFields, updatedAt: new Date() }).where(eq(homeworks.id, id)));
    }
    if (plan) {
      const deletedIds = new Set(plan.toDelete.map((d) => d.id));
      for (const del of plan.toDelete) {
        statements.push(db.delete(sections).where(eq(sections.id, del.id)));
      }
      await resolveSectionWrites(
        existingSections,
        deletedIds,
        plan,
        (sectionId, order, title, content, type) => {
          statements.push(db.insert(sections).values({ id: sectionId, homeworkId: id, title, content, order, type }));
        },
        (sectionId, order, title, content, type) => {
          statements.push(db.update(sections).set({ title, content, order, type, updatedAt: new Date() }).where(eq(sections.id, sectionId)));
        },
        (sectionId, action, content) => {
          if (action === "create") {
            statements.push(db.insert(sectionSolutions).values({ sectionId, content: content! }));
          } else if (action === "update") {
            statements.push(db.update(sectionSolutions).set({ content: content!, updatedAt: new Date() }).where(eq(sectionSolutions.sectionId, sectionId)));
          } else if (action === "delete") {
            statements.push(db.delete(sectionSolutions).where(eq(sectionSolutions.sectionId, sectionId)));
          }
        },
      );
    }
    if (widgetPlan) {
      const deletedWidgetIds = new Set(widgetPlan.toDelete.map((d) => d.id));
      for (const del of widgetPlan.toDelete) {
        statements.push(db.delete(homeworkProgressWidgets).where(eq(homeworkProgressWidgets.id, del.id)));
      }
      await resolveWidgetWrites(
        existingWidgets,
        deletedWidgetIds,
        widgetPlan,
        (widgetId, order, prePrompt, postPrompt) => {
          statements.push(db.insert(homeworkProgressWidgets).values({ id: widgetId, homeworkId: id, prePrompt, postPrompt, order }));
        },
        (widgetId, order, prePrompt, postPrompt) => {
          statements.push(db.update(homeworkProgressWidgets).set({ prePrompt, postPrompt, order, updatedAt: new Date() }).where(eq(homeworkProgressWidgets.id, widgetId)));
        },
      );
    }
    if (statements.length > 0) {
      // The installed drizzle-orm's neon-http batch() signature is
      // `batch<U extends BatchItem<'pg'>, T extends Readonly<[U, ...U[]]>>
      // (queries: T)` -- a non-empty tuple type, not a plain array. This
      // cast is required because `statements` is built up as
      // `BatchStatement[]` (its length isn't known statically); the
      // `statements.length > 0` check above is what makes the cast sound
      // at runtime.
      await db.batch(statements as [BatchStatement, ...BatchStatement[]]);
    }
    return { id };
  }

  // Test/dev path: node-postgres (makeNodeDb) has no runtime db.batch().
  // A real db.transaction() gives the same all-or-nothing guarantee
  // through a different Drizzle primitive -- every write executes
  // immediately against `tx` rather than deferring into an array.
  return db.transaction(async (tx) => {
    if (Object.keys(topLevelFields).length > 0) {
      await tx.update(homeworks).set({ ...topLevelFields, updatedAt: new Date() }).where(eq(homeworks.id, id));
    }
    if (plan) {
      const deletedIds = new Set(plan.toDelete.map((d) => d.id));
      for (const del of plan.toDelete) {
        await tx.delete(sections).where(eq(sections.id, del.id));
      }
      await resolveSectionWrites(
        existingSections,
        deletedIds,
        plan,
        async (sectionId, order, title, content, type) => {
          await tx.insert(sections).values({ id: sectionId, homeworkId: id, title, content, order, type });
        },
        async (sectionId, order, title, content, type) => {
          await tx.update(sections).set({ title, content, order, type, updatedAt: new Date() }).where(eq(sections.id, sectionId));
        },
        async (sectionId, action, content) => {
          if (action === "create") {
            await tx.insert(sectionSolutions).values({ sectionId, content: content! });
          } else if (action === "update") {
            await tx.update(sectionSolutions).set({ content: content!, updatedAt: new Date() }).where(eq(sectionSolutions.sectionId, sectionId));
          } else if (action === "delete") {
            await tx.delete(sectionSolutions).where(eq(sectionSolutions.sectionId, sectionId));
          }
        },
      );
    }
    if (widgetPlan) {
      const deletedWidgetIds = new Set(widgetPlan.toDelete.map((d) => d.id));
      for (const del of widgetPlan.toDelete) {
        await tx.delete(homeworkProgressWidgets).where(eq(homeworkProgressWidgets.id, del.id));
      }
      await resolveWidgetWrites(
        existingWidgets,
        deletedWidgetIds,
        widgetPlan,
        async (widgetId, order, prePrompt, postPrompt) => {
          await tx.insert(homeworkProgressWidgets).values({ id: widgetId, homeworkId: id, prePrompt, postPrompt, order });
        },
        async (widgetId, order, prePrompt, postPrompt) => {
          await tx.update(homeworkProgressWidgets).set({ prePrompt, postPrompt, order, updatedAt: new Date() }).where(eq(homeworkProgressWidgets.id, widgetId));
        },
      );
    }
    return { id };
  });
}
