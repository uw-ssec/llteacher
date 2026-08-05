export interface ExistingSection {
  id: string;
  order: number;
  title: string;
  content: string;
  solutionId: string | null;
}

export interface IncomingSection {
  id?: string;
  order: number;
  title: string;
  content: string;
  solutionContent?: string;
}

export interface SectionCreatePlan {
  title: string;
  content: string;
  order: number;
  solutionContent: string | undefined;
}

export interface SectionUpdatePlan {
  id: string;
  title: string;
  content: string;
  order: number;
  solutionContent: string | undefined;
  /** "none": no solution before or after. "create": had none, now has one.
   *  "update": had one, still has one (content may differ). "delete": had
   *  one, incoming omitted solutionContent. */
  solutionAction: "none" | "create" | "update" | "delete";
}

export interface SectionDeletePlan {
  id: string;
}

export interface SectionDiffPlan {
  toCreate: SectionCreatePlan[];
  toUpdate: SectionUpdatePlan[];
  toDelete: SectionDeletePlan[];
}

/** Pure diff logic, no DB access -- repositories/homeworks.ts's updateHomework
 *  applies this plan inside a transaction. Kept separate so the diff
 *  algorithm (the trickiest part of #19, per the issue) is unit-testable
 *  without mocking Drizzle. */
export function planSectionDiff(
  existing: ExistingSection[],
  incoming: IncomingSection[],
): SectionDiffPlan {
  const orders = new Set<number>();
  for (const s of incoming) {
    if (orders.has(s.order)) {
      throw new Error(`duplicate order ${s.order} in incoming sections`);
    }
    orders.add(s.order);
  }

  const existingById = new Map(existing.map((s) => [s.id, s]));
  const incomingIds = new Set(incoming.filter((s) => s.id).map((s) => s.id));

  const toCreate: SectionCreatePlan[] = [];
  const toUpdate: SectionUpdatePlan[] = [];

  for (const s of incoming) {
    if (!s.id) {
      toCreate.push({
        title: s.title,
        content: s.content,
        order: s.order,
        solutionContent: s.solutionContent,
      });
      continue;
    }
    const prior = existingById.get(s.id);
    if (!prior) {
      throw new Error(`unknown section id "${s.id}" -- not part of this homework`);
    }
    const hadSolution = prior.solutionId !== null;
    const hasSolution = s.solutionContent !== undefined;
    const solutionAction: SectionUpdatePlan["solutionAction"] = !hadSolution && !hasSolution
      ? "none"
      : !hadSolution && hasSolution
        ? "create"
        : hadSolution && hasSolution
          ? "update"
          : "delete";

    // Only include in toUpdate if something actually changed
    const titleChanged = prior.title !== s.title;
    const contentChanged = prior.content !== s.content;
    const orderChanged = prior.order !== s.order;
    const solutionChanged = solutionAction !== "none";

    if (titleChanged || contentChanged || orderChanged || solutionChanged) {
      toUpdate.push({
        id: s.id,
        title: s.title,
        content: s.content,
        order: s.order,
        solutionContent: s.solutionContent,
        solutionAction,
      });
    }
  }

  const toDelete: SectionDeletePlan[] = existing
    .filter((s) => !incomingIds.has(s.id))
    .map((s) => ({ id: s.id }));

  return { toCreate, toUpdate, toDelete };
}
