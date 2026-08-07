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
