import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { homeworkProgressWidgets, homeworks, courses, homeworkProgressWidgetResponses } from "../../db/schema";
import type { OrgScope } from "./scope";

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
    if (orders.has(w.order)) {
      throw new Error(`duplicate order ${w.order} in incoming widgets`);
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
      throw new Error(`unknown widget id "${w.id}" -- not part of this homework`);
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
 *  (pre answered, post never answered) is a valid, expected state. */
export async function submitWidgetResponse(
  db: Db,
  scope: OrgScope,
  widgetId: string,
  userId: string,
  input: { which: "pre" | "post"; value: number },
) {
  const [owned] = await db
    .select({ id: homeworkProgressWidgets.id })
    .from(homeworkProgressWidgets)
    .innerJoin(homeworks, eq(homeworkProgressWidgets.homeworkId, homeworks.id))
    .innerJoin(courses, eq(homeworks.courseId, courses.id))
    .where(and(eq(homeworkProgressWidgets.id, widgetId), eq(courses.organizationId, scope)));
  if (!owned) {
    throw new Error("Widget not found in this org scope");
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

  const [created] = await db
    .insert(homeworkProgressWidgetResponses)
    .values({ widgetId, userId, ...columnSet })
    .returning();
  return created!;
}
