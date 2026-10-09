/* --------------------------------------------------------------------------
   Health informatics frameworks for the generative-UI figures.

   Three fixed frameworks the figures own outright -- the model never names
   an aim, a dimension or a level, it only fills them in:
   - the Quadruple Aim (Bodenheimer & Sinsky, 2014), with health equity as
     an optional fifth aim (the Quintuple Aim; Nundy, Cooper & Mate, 2022);
   - Sittig & Singh's eight-dimension sociotechnical model for health IT
     (Qual Saf Health Care, 2010);
   - the data → information → knowledge → wisdom (DIKW) continuum used by
     the ANA's Nursing Informatics: Scope and Standards of Practice.
   Every count, list and sentence a figure states is computed here.
   -------------------------------------------------------------------------- */

/** "a", "a and b", "a, b and c". */
export function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Drops trailing sentence punctuation, so model text can sit mid-sentence. */
export function clause(s: string): string {
  return s.trim().replace(/[\s.;:,!]+$/u, "");
}

/* -- Quadruple Aim --------------------------------------------------------- */

export const AIM_IDS = ["patientExperience", "populationHealth", "costOfCare", "careTeamWellBeing", "healthEquity"] as const;
export type AimId = (typeof AIM_IDS)[number];

export interface AimDef {
  id: AimId;
  name: string;
  definition: string;
  /** Categorical slot: an aim keeps its colour wherever it appears. */
  slot: 1 | 2 | 3 | 4 | 5;
}

/** The aims in their fixed order; health equity is the optional fifth. */
export const AIMS: readonly AimDef[] = [
  {
    id: "patientExperience",
    name: "Patient experience of care",
    definition: "Care as patients and families experience it, including quality, safety and satisfaction.",
    slot: 1,
  },
  {
    id: "populationHealth",
    name: "Population health",
    definition: "The health outcomes of a whole group of people, not only the patients seen today.",
    slot: 2,
  },
  {
    id: "costOfCare",
    name: "Cost of care",
    definition: "Per-capita cost of care for that group. Here “improves” means the cost goes down.",
    slot: 3,
  },
  {
    id: "careTeamWellBeing",
    name: "Care team well-being",
    definition: "The work life of nurses, physicians and staff: workload, documentation burden, burnout.",
    slot: 4,
  },
  {
    id: "healthEquity",
    name: "Health equity",
    definition: "Fair, just care: narrowing the gaps in access and outcomes between groups of people.",
    slot: 5,
  },
];

export const AIM_EFFECTS = ["improves", "worsens", "mixed", "unclear"] as const;
export type AimEffect = (typeof AIM_EFFECTS)[number];

export interface AimAssessment {
  effect: AimEffect;
  /** Why the intervention has this effect. */
  rationale: string;
  /** How you would measure it, e.g. "portal activation rate". */
  measure: string;
}

export type AimInputs = Partial<Record<AimId, AimAssessment>>;

/** The aims in play: four, or five when equity is included. */
export function aimsInPlay(includeEquity: boolean): readonly AimDef[] {
  return includeEquity ? AIMS : AIMS.slice(0, 4);
}

export interface AimSummary {
  total: number;
  counts: Record<AimEffect, number>;
  /** Aims that worsen or are mixed while at least one other aim improves. */
  tradeOffs: AimDef[];
  /** Aims that worsen or are mixed when none improves. */
  concerns: AimDef[];
  unclear: AimDef[];
  sentence: string;
}

const lower = (name: string) => name.charAt(0).toLowerCase() + name.slice(1);

export function summarizeAims(aims: AimInputs, includeEquity: boolean): AimSummary {
  const defs = aimsInPlay(includeEquity);
  const counts: Record<AimEffect, number> = { improves: 0, worsens: 0, mixed: 0, unclear: 0 };
  for (const d of defs) counts[aims[d.id]!.effect] += 1;
  const total = defs.length;
  const downside = defs.filter((d) => aims[d.id]!.effect === "worsens" || aims[d.id]!.effect === "mixed");
  const tradeOffs = counts.improves > 0 ? downside : [];
  const concerns = counts.improves > 0 ? [] : downside;
  const unclear = defs.filter((d) => aims[d.id]!.effect === "unclear");
  const named = (ds: AimDef[]) => joinList(ds.map((d) => `${lower(d.name)} (${aims[d.id]!.effect})`));

  let sentence =
    counts.improves === total
      ? `Improves all ${total} aims`
      : counts.improves === 0
        ? `Improves none of the ${total} aims`
        : `Improves ${counts.improves} of ${total} aims`;
  if (tradeOffs.length) sentence += `; trade-off${tradeOffs.length === 1 ? "" : "s"}: ${named(tradeOffs)}`;
  else if (concerns.length) sentence += `; ${named(concerns)}, with no aim improving to offset ${concerns.length === 1 ? "it" : "them"}`;
  else if (counts.improves > 0 && counts.improves < total) sentence += "; no trade-off named";
  sentence += ".";
  if (unclear.length) {
    sentence += ` Effect unclear for ${joinList(unclear.map((d) => lower(d.name)))}: ${unclear.length === 1 ? "its measure" : "their measures"} would settle it.`;
  }
  return { total, counts, tradeOffs, concerns, unclear, sentence };
}

/* -- Sociotechnical model (Sittig & Singh, 2010) --------------------------- */

export const STM_IDS = [
  "infrastructure",
  "clinicalContent",
  "interface",
  "people",
  "workflow",
  "organization",
  "externalRules",
  "measurement",
] as const;
export type StmId = (typeof STM_IDS)[number];

export interface StmDimension {
  id: StmId;
  /** 1-8, the model's own numbering. */
  n: number;
  name: string;
  /** Used in computed sentences, where the full name's commas would blur a list. */
  short: string;
  definition: string;
}

export const STM_DIMENSIONS: readonly StmDimension[] = [
  {
    id: "infrastructure",
    n: 1,
    name: "Hardware and software computing infrastructure",
    short: "infrastructure",
    definition: "Devices, networks, servers and software that run the system, and whether they are available when needed.",
  },
  {
    id: "clinicalContent",
    n: 2,
    name: "Clinical content",
    short: "clinical content",
    definition: "The data, order sets, rules, alerts and reference knowledge stored in or shown by the system.",
  },
  {
    id: "interface",
    n: 3,
    name: "Human–computer interface",
    short: "human–computer interface",
    definition: "What users see, touch and hear: screens, alerts, scanners, and how many steps a task takes.",
  },
  {
    id: "people",
    n: 4,
    name: "People",
    short: "people",
    definition: "Everyone who designs, uses or is affected by the system: their training, knowledge and workload.",
  },
  {
    id: "workflow",
    n: 5,
    name: "Workflow and communication",
    short: "workflow and communication",
    definition: "The steps of care and the hand-offs between people, and how well the system fits them.",
  },
  {
    id: "organization",
    n: 6,
    name: "Internal organizational policies, procedures, and culture",
    short: "internal policies and culture",
    definition: "The organization's own rules, staffing, budget decisions and safety culture.",
  },
  {
    id: "externalRules",
    n: 7,
    name: "External rules, regulations, and pressures",
    short: "external rules and pressures",
    definition: "Forces from outside: regulation, accreditation, payment rules, public reporting.",
  },
  {
    id: "measurement",
    n: 8,
    name: "System measurement and monitoring",
    short: "measurement and monitoring",
    definition: "How the organization tracks the system's use, effects and failures, and acts on them.",
  },
];

export const STM_ROLES = ["contributing", "protective", "not assessed"] as const;
export type StmRole = (typeof STM_ROLES)[number];

export interface StmFinding {
  dimension: StmId;
  role: StmRole;
  /** What was found in this dimension; may be omitted when not assessed. */
  finding?: string;
}

export interface StmRow extends StmDimension {
  role: StmRole;
  finding?: string;
}

export interface StmSummary {
  /** All eight, in the model's order; unsupplied dimensions are not assessed. */
  rows: StmRow[];
  contributing: StmRow[];
  protective: StmRow[];
  notAssessed: StmRow[];
  sentence: string;
}

export function summarizeSociotechnical(findings: readonly StmFinding[]): StmSummary {
  const byId = new Map(findings.map((f) => [f.dimension, f]));
  const rows: StmRow[] = STM_DIMENSIONS.map((d) => {
    const f = byId.get(d.id);
    return f ? { ...d, role: f.role, finding: f.finding } : { ...d, role: "not assessed" as const };
  });
  const contributing = rows.filter((r) => r.role === "contributing");
  const protective = rows.filter((r) => r.role === "protective");
  const notAssessed = rows.filter((r) => r.role === "not assessed");
  const names = (rs: StmRow[]) => joinList(rs.map((r) => `${r.short} (${r.n})`));

  const parts: string[] = [];
  parts.push(
    contributing.length === 0
      ? "No dimension was found to contribute to the problem."
      : `${contributing.length} of 8 dimensions contribute to the problem: ${names(contributing)}.`,
  );
  if (protective.length) parts.push(`${protective.length} protective: ${names(protective)}.`);
  parts.push(notAssessed.length === 0 ? "All 8 were assessed." : `${notAssessed.length} not assessed.`);
  return { rows, contributing, protective, notAssessed, sentence: parts.join(" ") };
}

/* -- DIKW ------------------------------------------------------------------ */

export const DIKW_IDS = ["data", "information", "knowledge", "wisdom"] as const;
export type DikwId = (typeof DIKW_IDS)[number];

export interface DikwLevel {
  id: DikwId;
  n: 1 | 2 | 3 | 4;
  name: string;
  definition: string;
}

export const DIKW_LEVELS: readonly DikwLevel[] = [
  { id: "data", n: 1, name: "Data", definition: "Discrete, objective facts recorded without interpretation." },
  { id: "information", n: 2, name: "Information", definition: "Data interpreted, organized or structured so they carry meaning." },
  { id: "knowledge", n: 3, name: "Knowledge", definition: "Information synthesized so that relationships and patterns are identified." },
  { id: "wisdom", n: 4, name: "Wisdom", definition: "Knowledge applied with judgment: knowing when and how to act on it." },
];

export type DikwExamples = Record<DikwId, string>;

export function dikwSentence(ex: DikwExamples, action?: string): string {
  const base = `From data (${clause(ex.data)}) to wisdom (${clause(ex.wisdom)}): ${DIKW_LEVELS.length} levels, each built on the one before.`;
  return action ? `${base} Resulting action: ${clause(action)}.` : base;
}
