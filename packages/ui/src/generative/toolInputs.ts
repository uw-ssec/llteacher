/* --------------------------------------------------------------------------
   Runtime validation for the subject-figure tools' model-generated input.

   Same deny-by-default rule as parseShowDefinitionInput (render.tsx): the
   input is the model's own JSON, so every field is checked for type AND
   for meaning (an MPC of 1.2, two aligned sequences of different length, a
   curve the model doesn't have). Anything wrong returns null -- the
   registry then shows nothing rather than a confidently wrong figure.
   -------------------------------------------------------------------------- */

import { MACRO_MODELS, type MacroModelKind } from "./lib/econ";
import { DEFAULT_SCHEME, normalizeDna, parseNewick, leaves, type AlignmentScheme } from "./lib/bio";
import type { MacroModelDiagramProps, MacroShift } from "./renderers/econ/MacroModelDiagram";
import { resolveCurveId } from "./renderers/econ/MacroModelDiagram";
import type { GdpCompositionProps } from "./renderers/econ/GdpComposition";
import type { MultiplierRoundsProps } from "./renderers/econ/MultiplierRounds";
import type { LaborForceProps } from "./renderers/econ/LaborForce";
import type { PriceIndexProps } from "./renderers/econ/PriceIndex";
import type { SequenceAlignmentProps } from "./renderers/bio/SequenceAlignment";
import type { TranslationProps } from "./renderers/bio/Translation";
import type { PhyloTreeProps } from "./renderers/bio/PhyloTree";
import type { WorkedStepsProps, WorkedStep } from "./renderers/WorkedSteps";

type Obj = Record<string, unknown>;
type Parsed<P> = Omit<P, "isPartial">;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const optStr = (v: unknown, max = 200): string | undefined | null =>
  v === undefined ? undefined : typeof v === "string" && v.length <= max ? v : null;

export function parseWorkedStepsInput(v: unknown): Parsed<WorkedStepsProps> | null {
  if (!isObj(v) || typeof v.title !== "string" || !v.title.trim() || !Array.isArray(v.steps)) return null;
  if (v.steps.length === 0 || v.steps.length > 12) return null;
  const steps: WorkedStep[] = [];
  for (const raw of v.steps) {
    if (!isObj(raw)) return null;
    const label = optStr(raw.label, 120);
    const expression = optStr(raw.expression, 400);
    const explanation = optStr(raw.explanation, 600);
    if (label === null || expression === null || explanation === null) return null;
    if (!label && !expression && !explanation) return null;
    steps.push({ label, expression, explanation });
  }
  let result: WorkedStepsProps["result"];
  if (v.result !== undefined) {
    if (!isObj(v.result) || typeof v.result.label !== "string" || typeof v.result.value !== "string") return null;
    result = { label: v.result.label, value: v.result.value };
  }
  return { title: v.title, steps, result };
}

export function parseMacroModelInput(v: unknown): Parsed<MacroModelDiagramProps> | null {
  if (!isObj(v) || typeof v.model !== "string" || !(v.model in MACRO_MODELS)) return null;
  const model = v.model as MacroModelKind;
  const rawShifts = v.shifts ?? [];
  if (!Array.isArray(rawShifts) || rawShifts.length > 3) return null;
  const shifts: MacroShift[] = [];
  for (const s of rawShifts) {
    if (!isObj(s) || typeof s.curve !== "string") return null;
    if (s.direction !== "left" && s.direction !== "right") return null;
    const curve = resolveCurveId(model, s.curve);
    if (!curve || shifts.some((x) => x.curve === curve)) return null;
    const reason = optStr(s.reason, 140);
    if (reason === null) return null;
    shifts.push({ curve, direction: s.direction, reason });
  }
  const title = optStr(v.title, 120);
  if (title === null) return null;
  return { model, shifts, title };
}

export function parseGdpCompositionInput(v: unknown): Parsed<GdpCompositionProps> | null {
  if (!isObj(v)) return null;
  const { consumption, investment, government, netExports } = v;
  if (![consumption, investment, government, netExports].every(isFiniteNum)) return null;
  const c = consumption as number, i = investment as number, g = government as number, nx = netExports as number;
  if (c < 0 || i < 0 || g < 0 || c + i + g + nx <= 0) return null;
  const label = optStr(v.label, 80);
  const unit = optStr(v.unit, 40);
  if (label === null || unit === null) return null;
  return { consumption: c, investment: i, government: g, netExports: nx, label, unit };
}

export function parseMultiplierInput(v: unknown): Parsed<MultiplierRoundsProps> | null {
  if (!isObj(v) || !isFiniteNum(v.mpc) || !isFiniteNum(v.initialChange)) return null;
  if (v.mpc <= 0 || v.mpc >= 1 || v.initialChange === 0) return null;
  if (v.rounds !== undefined && (!isFiniteNum(v.rounds) || v.rounds < 1)) return null;
  const label = optStr(v.label, 80);
  const unit = optStr(v.unit, 40);
  if (label === null || unit === null) return null;
  return { mpc: v.mpc, initialChange: v.initialChange, rounds: v.rounds as number | undefined, label, unit };
}

export function parseLaborForceInput(v: unknown): Parsed<LaborForceProps> | null {
  if (!isObj(v)) return null;
  const { employed, unemployed, notInLaborForce } = v;
  if (![employed, unemployed, notInLaborForce].every((x) => isFiniteNum(x) && x >= 0)) return null;
  if ((employed as number) + (unemployed as number) <= 0) return null;
  const label = optStr(v.label, 80);
  const unit = optStr(v.unit, 40);
  if (label === null || unit === null) return null;
  return { employed: employed as number, unemployed: unemployed as number, notInLaborForce: notInLaborForce as number, label, unit };
}

export function parseInflationInput(v: unknown): Parsed<PriceIndexProps> | null {
  if (!isObj(v) || !Array.isArray(v.series) || v.series.length < 2 || v.series.length > 24) return null;
  const series: PriceIndexProps["series"] = [];
  for (const p of v.series) {
    if (!isObj(p) || typeof p.period !== "string" || !p.period || !isFiniteNum(p.value) || p.value <= 0) return null;
    series.push({ period: p.period.slice(0, 12), value: p.value });
  }
  if (new Set(series.map((p) => p.period)).size !== series.length) return null;
  const indexName = optStr(v.indexName, 60);
  if (indexName === null) return null;
  return { series, indexName };
}

const DNA_ALIGN = /^[ACGTUN-]+$/;
const PROTEIN_ALIGN = /^[ACDEFGHIKLMNPQRSTVWYBZXU*-]+$/;

export function parseAlignmentInput(v: unknown): Parsed<SequenceAlignmentProps> | null {
  if (!isObj(v) || typeof v.seqA !== "string" || typeof v.seqB !== "string") return null;
  const kind = v.kind === "protein" ? "protein" : v.kind === "dna" ? "dna" : null;
  if (!kind) return null;
  const a = v.seqA.replace(/\s/g, "").toUpperCase();
  const b = v.seqB.replace(/\s/g, "").toUpperCase();
  if (!a || a.length !== b.length || a.length > 2000) return null;
  const alphabet = kind === "dna" ? DNA_ALIGN : PROTEIN_ALIGN;
  if (!alphabet.test(a) || !alphabet.test(b)) return null;
  for (let i = 0; i < a.length; i++) if (a[i] === "-" && b[i] === "-") return null;
  const nameA = optStr(v.nameA, 40);
  const nameB = optStr(v.nameB, 40);
  if (nameA === null || nameB === null) return null;
  let scheme: AlignmentScheme = DEFAULT_SCHEME;
  if (v.scheme !== undefined) {
    if (!isObj(v.scheme) || ![v.scheme.match, v.scheme.mismatch, v.scheme.gap].every(isFiniteNum)) return null;
    scheme = { match: v.scheme.match as number, mismatch: v.scheme.mismatch as number, gap: v.scheme.gap as number };
  }
  return { seqA: a, seqB: b, nameA: nameA || "Seq A", nameB: nameB || "Seq B", kind, scheme };
}

export function parseTranslationInput(v: unknown): Parsed<TranslationProps> | null {
  if (!isObj(v) || typeof v.dna !== "string") return null;
  const { dna, invalid } = normalizeDna(v.dna);
  if (invalid.length > 0 || dna.length < 3 || dna.length > 360) return null;
  const frame = v.frame === undefined ? 0 : v.frame;
  if (frame !== 0 && frame !== 1 && frame !== 2) return null;
  if (dna.length - frame < 3) return null;
  const label = optStr(v.label, 60);
  if (label === null) return null;
  return { dna, frame, label };
}

export function parsePhyloTreeInput(v: unknown): Parsed<PhyloTreeProps> | null {
  if (!isObj(v) || typeof v.newick !== "string" || v.newick.length > 4000) return null;
  const tree = parseNewick(v.newick);
  if (!tree) return null;
  const tips = leaves(tree).length;
  if (tips < 2 || tips > 40) return null;
  const title = optStr(v.title, 120);
  if (title === null) return null;
  return { newick: v.newick, title };
}
