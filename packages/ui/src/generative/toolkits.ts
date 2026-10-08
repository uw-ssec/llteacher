/** Subject figure packs ("toolkits") an instructor can enable per LLM config.
 *
 *  Plain TypeScript, no React -- the same pattern (and reason) as
 *  renderableTools.ts: the server (which tools a turn OFFERS the model),
 *  the admin console (the checkboxes), and the tests all read this one
 *  definition instead of hand-kept mirrors.
 *
 *  Opt-in by design: an LLM config stores the ids it enables
 *  (llm_configs.genui_toolkits, empty by default), and a tool that belongs
 *  to a pack is offered to the model ONLY when that pack is enabled. A
 *  student can therefore only ever be shown figures from the packs their
 *  instructor chose. Tools outside every pack (showDefinition,
 *  showWorkedSteps, knowledgeCheck, executeRCode, ...) are subject-neutral
 *  and stay available as before.
 *
 *  ADDING A PACK: add an entry here; its tools must also be in
 *  RENDERABLE_TOOL_NAMES with a renderer (toolkits.test.ts checks both). */

export const TOOLKITS = [
  {
    id: "economics",
    label: "Economics (intro macro)",
    description: "AD-AS, loanable funds and money-market shifts; GDP by expenditure; the spending multiplier; unemployment; inflation.",
    tools: ["showMacroModel", "showGdpComposition", "showMultiplier", "showLaborForce", "showInflation"],
  },
  {
    id: "clinical-informatics",
    label: "Clinical informatics",
    description: "Diagnostic test accuracy, prevalence and predictive value, ROC curves, patient timelines, decision-support rules.",
    tools: ["showDiagnosticAccuracy", "showPrevalenceEffect", "showRocCurve", "showPatientTimeline", "showCdsRule"],
  },
  {
    id: "statistics",
    label: "Statistics",
    description: "Probability distributions (normal, t, binomial, chi-square) with a shaded region and its probability.",
    tools: ["showDistribution"],
  },
] as const;

export type ToolkitId = (typeof TOOLKITS)[number]["id"];

const TOOLKIT_IDS: ReadonlySet<string> = new Set(TOOLKITS.map((t) => t.id));

export function isToolkitId(value: unknown): value is ToolkitId {
  return typeof value === "string" && TOOLKIT_IDS.has(value);
}

/** Every tool that belongs to some pack -- i.e. every tool that is gated. */
export const TOOLKIT_TOOL_NAMES: ReadonlySet<string> = new Set(TOOLKITS.flatMap((t) => [...t.tools]));

/** Keeps the known, de-duplicated ids from a stored or submitted list, in
 *  catalog order. Unknown ids (a pack since removed, a typo) are dropped,
 *  never trusted. */
export function normalizeToolkitIds(values: readonly unknown[]): ToolkitId[] {
  const wanted = new Set(values.filter(isToolkitId));
  return TOOLKITS.map((t) => t.id).filter((id) => wanted.has(id));
}

/** True when a tool may be offered under the enabled packs: always for a
 *  tool outside every pack, otherwise only if one of its packs is enabled. */
export function isToolEnabled(toolName: string, enabled: readonly string[]): boolean {
  if (!TOOLKIT_TOOL_NAMES.has(toolName)) return true;
  return TOOLKITS.some((t) => enabled.includes(t.id) && (t.tools as readonly string[]).includes(toolName));
}
