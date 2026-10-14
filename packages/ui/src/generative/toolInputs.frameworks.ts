/* --------------------------------------------------------------------------
   Runtime validation for the health informatics framework figures
   (Quadruple Aim, sociotechnical model, DIKW).

   Same deny-by-default rule as toolInputs.ts: the input is the model's own
   JSON, so every field is checked for type AND for meaning -- an aim the
   framework does not have, an equity assessment when equity was not asked
   for, a dimension named twice, a case with nothing assessed, the same
   example at two DIKW levels. Anything wrong returns null, and the
   registry shows nothing rather than a confidently wrong figure.
   -------------------------------------------------------------------------- */

import {
  AIM_EFFECTS,
  AIM_IDS,
  DIKW_IDS,
  STM_IDS,
  STM_ROLES,
  aimsInPlay,
  type AimEffect,
  type AimInputs,
  type DikwExamples,
  type StmFinding,
  type StmId,
  type StmRole,
} from "./lib/frameworks";
import type { QuadrupleAimProps } from "./renderers/informatics/QuadrupleAim";
import type { SociotechnicalModelProps } from "./renderers/informatics/SociotechnicalModel";
import type { DikwProps } from "./renderers/informatics/Dikw";

type Obj = Record<string, unknown>;
type Parsed<P> = Omit<P, "isPartial">;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const optStr = (v: unknown, max = 200): string | undefined | null =>
  v === undefined ? undefined : typeof v === "string" && v.trim() && v.length <= max ? v : null;
const reqStr = (v: unknown, max = 200): string | null => (typeof v === "string" && v.trim() && v.length <= max ? v : null);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

export function parseQuadrupleAimInput(v: unknown): Parsed<QuadrupleAimProps> | null {
  if (!isObj(v) || !isObj(v.aims)) return null;
  const intervention = reqStr(v.intervention, 120);
  if (intervention === null) return null;
  if (v.includeEquity !== undefined && typeof v.includeEquity !== "boolean") return null;
  const includeEquity = v.includeEquity === true;
  const inPlay = aimsInPlay(includeEquity).map((d) => d.id as string);
  // Exactly the aims in play: no unknown aim, none missing, and no equity
  // assessment unless equity was asked for.
  const keys = Object.keys(v.aims);
  if (keys.length !== inPlay.length || !keys.every((k) => inPlay.includes(k))) return null;
  const aims: AimInputs = {};
  for (const id of AIM_IDS) {
    if (!inPlay.includes(id)) continue;
    const a = v.aims[id];
    if (!isObj(a) || !oneOf<AimEffect>(AIM_EFFECTS, a.effect)) return null;
    const rationale = reqStr(a.rationale, 200);
    const measure = reqStr(a.measure, 120);
    if (rationale === null || measure === null) return null;
    aims[id] = { effect: a.effect, rationale, measure };
  }
  return { intervention, aims, includeEquity };
}

export function parseSociotechnicalInput(v: unknown): Parsed<SociotechnicalModelProps> | null {
  if (!isObj(v) || !Array.isArray(v.findings) || v.findings.length < 1 || v.findings.length > STM_IDS.length) return null;
  const caseTitle = reqStr(v.caseTitle, 140);
  if (caseTitle === null) return null;
  const seen = new Set<string>();
  const findings: StmFinding[] = [];
  for (const f of v.findings) {
    if (!isObj(f) || !oneOf<StmId>(STM_IDS, f.dimension) || !oneOf<StmRole>(STM_ROLES, f.role)) return null;
    if (seen.has(f.dimension)) return null;
    seen.add(f.dimension);
    // A dimension judged contributing or protective must say what was found.
    const finding = f.role === "not assessed" ? optStr(f.finding, 200) : reqStr(f.finding, 200);
    if (finding === null) return null;
    findings.push(finding === undefined ? { dimension: f.dimension, role: f.role } : { dimension: f.dimension, role: f.role, finding });
  }
  if (!findings.some((f) => f.role !== "not assessed")) return null;
  return { caseTitle, findings };
}

export function parseDikwInput(v: unknown): Parsed<DikwProps> | null {
  if (!isObj(v) || !isObj(v.examples)) return null;
  const scenario = reqStr(v.scenario, 120);
  if (scenario === null) return null;
  const examples = {} as DikwExamples;
  for (const id of DIKW_IDS) {
    const ex = reqStr(v.examples[id], 200);
    if (ex === null) return null;
    examples[id] = ex;
  }
  if (Object.keys(v.examples).length !== DIKW_IDS.length) return null;
  // The same example at two levels is not a progression.
  const norm = DIKW_IDS.map((id) => examples[id].trim().toLowerCase());
  if (new Set(norm).size !== norm.length) return null;
  const action = optStr(v.action, 160);
  if (action === null) return null;
  return action === undefined ? { scenario, examples } : { scenario, examples, action };
}
