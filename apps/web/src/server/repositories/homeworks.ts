import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { homeworks, sections, sectionSolutions, conversations } from "../../db/schema";
import type { CourseScope } from "./scope";
import {
  planSectionDiff,
  type ExistingSection,
  type IncomingSection,
  type SectionUpdatePlan,
} from "./sections";
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
  if (hw.isHidden || (hw.expiresAt !== null && hw.expiresAt.getTime() <= now.getTime())) {
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

  return { homework, sections: sectionRows };
}

export async function deleteHomework(db: Db, scope: CourseScope, id: string) {
  // sections/sectionSolutions/conversations/messages/submissions all cascade
  // from homeworks.id -> sections.homeworkId -> ... (see Resolved Design
  // Decision 3) -- a single delete on this scoped row is sufficient.
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
  pushSectionInsert: (id: string, order: number, title: string, content: string) => Promise<void> | void,
  pushSectionUpdate: (id: string, order: number, title: string, content: string) => Promise<void> | void,
  pushSolutionWrites: (sectionId: string, action: SectionUpdatePlan["solutionAction"], content: string | undefined) => Promise<void> | void,
) {
  type PendingWrite =
    | { kind: "update"; id: string; targetOrder: number; title: string; content: string; solutionAction: SectionUpdatePlan["solutionAction"]; solutionContent?: string }
    | { kind: "create"; id: string; targetOrder: number; title: string; content: string; solutionContent?: string };

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
      await pushSectionUpdate(upd.id, upd.order, upd.title, upd.content);
      await pushSolutionWrites(upd.id, upd.solutionAction, upd.solutionContent);
    } else {
      pending.push({ kind: "update", id: upd.id, targetOrder: upd.order, title: upd.title, content: upd.content, solutionAction: upd.solutionAction, solutionContent: upd.solutionContent });
    }
  }
  for (const create of plan.toCreate) {
    pending.push({ kind: "create", id: crypto.randomUUID(), targetOrder: create.order, title: create.title, content: create.content, solutionContent: create.solutionContent });
  }

  const placed = new Set<PendingWrite>();

  async function apply(write: PendingWrite) {
    if (write.kind === "create") {
      await pushSectionInsert(write.id, write.targetOrder, write.title, write.content);
      if (write.solutionContent !== undefined) {
        await pushSolutionWrites(write.id, "create", write.solutionContent);
      }
    } else {
      await pushSectionUpdate(write.id, write.targetOrder, write.title, write.content);
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
    await pushSectionUpdate(stuck.id, scratch, existingById.get(stuck.id)!.title, existingById.get(stuck.id)!.content);
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
        (sectionId, order, title, content) => {
          statements.push(db.insert(sections).values({ id: sectionId, homeworkId: id, title, content, order }));
        },
        (sectionId, order, title, content) => {
          statements.push(db.update(sections).set({ title, content, order, updatedAt: new Date() }).where(eq(sections.id, sectionId)));
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
        async (sectionId, order, title, content) => {
          await tx.insert(sections).values({ id: sectionId, homeworkId: id, title, content, order });
        },
        async (sectionId, order, title, content) => {
          await tx.update(sections).set({ title, content, order, updatedAt: new Date() }).where(eq(sections.id, sectionId));
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
    return { id };
  });
}
