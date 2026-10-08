import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../../db/client";
import { homeworkProgressWidgets, homeworks, courses, courseMemberships, homeworkProgressWidgetResponses } from "../../db/schema";
import type { OrgScope } from "./scope";
import { isHomeworkHidden } from "./homeworks";
import { assertOrderInRange, ContentDiffError } from "./sections";

/** submitWidgetResponse's refusal: the widget is absent, in another org, the
 *  caller holds no live student membership in its course, or (#177) its
 *  homework is hidden/expired -- one class because the repository already
 *  gave them one message. Typed (it was a plain Error) so the route can
 *  translate exactly this and let a dropped connection reach the 503 path. */
export class WidgetNotFoundError extends Error {
  readonly _tag = "WidgetNotFoundError" as const;
  constructor() {
    super("Widget not found in this org scope");
    this.name = "WidgetNotFoundError";
  }
}

export interface ExistingWidget {
  id: string;
  order: number;
  prePrompt: string;
  postPrompt: string;
}

export interface IncomingWidget {
  id?: string;
  order: number;
  prePrompt: string;
  postPrompt: string;
}

export interface WidgetCreatePlan {
  prePrompt: string;
  postPrompt: string;
  order: number;
}

export interface WidgetUpdatePlan {
  id: string;
  prePrompt: string;
  postPrompt: string;
  order: number;
}

export interface WidgetDeletePlan {
  id: string;
}

export interface WidgetDiffPlan {
  toCreate: WidgetCreatePlan[];
  toUpdate: WidgetUpdatePlan[];
  toDelete: WidgetDeletePlan[];
}

/** #165: pure diff logic, no DB access -- structurally identical to
 *  planSectionDiff (repositories/sections.ts) minus the solution
 *  dimension, since widgets carry no equivalent sub-write. */
export function planWidgetDiff(
  existing: ExistingWidget[],
  incoming: IncomingWidget[],
): WidgetDiffPlan {
  const orders = new Set<number>();
  for (const w of incoming) {
    assertOrderInRange(w.order, "widget");
    if (orders.has(w.order)) {
      throw new ContentDiffError(`duplicate order ${w.order} in incoming widgets`);
    }
    orders.add(w.order);
  }

  const existingById = new Map(existing.map((w) => [w.id, w]));
  const incomingIds = new Set(incoming.filter((w) => w.id).map((w) => w.id));

  const toCreate: WidgetCreatePlan[] = [];
  const toUpdate: WidgetUpdatePlan[] = [];

  for (const w of incoming) {
    if (!w.id) {
      toCreate.push({ prePrompt: w.prePrompt, postPrompt: w.postPrompt, order: w.order });
      continue;
    }
    const prior = existingById.get(w.id);
    if (!prior) {
      throw new ContentDiffError(`unknown widget id "${w.id}" -- not part of this homework`);
    }

    const prePromptChanged = prior.prePrompt !== w.prePrompt;
    const postPromptChanged = prior.postPrompt !== w.postPrompt;
    const orderChanged = prior.order !== w.order;

    if (prePromptChanged || postPromptChanged || orderChanged) {
      toUpdate.push({ id: w.id, prePrompt: w.prePrompt, postPrompt: w.postPrompt, order: w.order });
    }
  }

  const toDelete: WidgetDeletePlan[] = existing
    .filter((w) => !incomingIds.has(w.id))
    .map((w) => ({ id: w.id }));

  return { toCreate, toUpdate, toDelete };
}

/** #165: verifies (via the real parent chain, never trusting the caller)
 *  that widgetId resolves to a widget within scope's org before writing --
 *  same rationale as upsertSectionAnswer/createSubmission's ownership-
 *  verification-via-join pattern. Upserts only the pre/post column pair
 *  matching `which`, leaving the other column pair untouched -- partial completion
 *  (pre answered, post never answered) is a valid, expected state.
 *  #175: also requires a non-dropped student membership in the widget's own
 *  course -- see upsertSectionAnswer's identical addition for the full
 *  rationale (no prior owned parent object to narrow this otherwise).
 *  #177: also rejects once the parent homework derives to hidden. */
export async function submitWidgetResponse(
  db: Db,
  scope: OrgScope,
  widgetId: string,
  userId: string,
  input: { which: "pre" | "post"; value: number },
) {
  const [owned] = await db
    .select({
      id: homeworkProgressWidgets.id,
      isHidden: homeworks.isHidden,
      expiresAt: homeworks.expiresAt,
    })
    .from(homeworkProgressWidgets)
    .innerJoin(homeworks, eq(homeworkProgressWidgets.homeworkId, homeworks.id))
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
    .where(and(eq(homeworkProgressWidgets.id, widgetId), eq(courses.organizationId, scope)));
  if (!owned) {
    throw new WidgetNotFoundError();
  }
  if (isHomeworkHidden(owned)) {
    throw new WidgetNotFoundError();
  }

  const [existing] = await db
    .select({ id: homeworkProgressWidgetResponses.id })
    .from(homeworkProgressWidgetResponses)
    .where(and(eq(homeworkProgressWidgetResponses.widgetId, widgetId), eq(homeworkProgressWidgetResponses.userId, userId)));

  const columnSet = input.which === "pre"
    ? { preValue: input.value, preSubmittedAt: new Date() }
    : { postValue: input.value, postSubmittedAt: new Date() };

  if (existing) {
    const [updated] = await db
      .update(homeworkProgressWidgetResponses)
      .set(columnSet)
      .where(eq(homeworkProgressWidgetResponses.id, existing.id))
      .returning();
    return updated!;
  }

  // #176: organizationId is now denormalized here the same way
  // upsertSectionAnswer's insert already carries it -- written from the
  // verified scope, never trusted from caller input.
  const [created] = await db
    .insert(homeworkProgressWidgetResponses)
    .values({ widgetId, userId, organizationId: scope, ...columnSet })
    .returning();
  return created!;
}
