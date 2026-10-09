/* --------------------------------------------------------------------------
   Runtime validation for the clinical informatics figure tools.

   Same deny-by-default rule as toolInputs.ts: the input is the model's own
   JSON, so every field is checked for type AND for meaning -- a count that
   is not a whole number, a sensitivity of 85 (a percentage, not a
   proportion), ROC points that cannot come from one test's thresholds, an
   impossible date, a rule comparing text with ">". Anything wrong returns
   null, and the registry shows nothing rather than a confidently wrong
   figure.
   -------------------------------------------------------------------------- */

import {
  CDS_OPERATORS,
  TIMELINE_CATEGORIES,
  isMonotoneRoc,
  parseClinicalTime,
  type CdsCondition,
  type CdsOperator,
  type PatientValue,
  type RocPoint,
  type TimelineCategory,
} from "./lib/clinical";
import type { DiagnosticAccuracyProps } from "./renderers/clinical/DiagnosticAccuracy";
import type { PrevalenceEffectProps } from "./renderers/clinical/PrevalenceEffect";
import type { RocCurveProps } from "./renderers/clinical/RocCurve";
import type { PatientTimelineProps, TimelineEvent } from "./renderers/clinical/PatientTimeline";
import type { CdsRuleProps } from "./renderers/clinical/CdsRule";

type Obj = Record<string, unknown>;
type Parsed<P> = Omit<P, "isPartial">;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1e9;
const optStr = (v: unknown, max = 200): string | undefined | null =>
  v === undefined ? undefined : typeof v === "string" && v.length <= max ? v : null;
const reqStr = (v: unknown, max = 200): string | null => (typeof v === "string" && v.trim() && v.length <= max ? v : null);
/** A proportion in (0, 1]: sensitivity and specificity of a usable test. */
const isRate = (v: unknown): v is number => isFiniteNum(v) && v > 0 && v <= 1;
const isUnit = (v: unknown): v is number => isFiniteNum(v) && v >= 0 && v <= 1;

export function parseDiagnosticAccuracyInput(v: unknown): Parsed<DiagnosticAccuracyProps> | null {
  if (!isObj(v)) return null;
  const { tp, fp, fn, tn } = v;
  if (!isCount(tp) || !isCount(fp) || !isCount(fn) || !isCount(tn)) return null;
  if (tp + fp + fn + tn === 0) return null;
  const testName = optStr(v.testName, 80);
  const conditionName = optStr(v.conditionName, 60);
  if (testName === null || conditionName === null) return null;
  return { tp, fp, fn, tn, testName, conditionName };
}

export function parsePrevalenceEffectInput(v: unknown): Parsed<PrevalenceEffectProps> | null {
  if (!isObj(v) || !isRate(v.sensitivity) || !isRate(v.specificity)) return null;
  if (!isFiniteNum(v.prevalence) || v.prevalence <= 0 || v.prevalence >= 1) return null;
  const testName = optStr(v.testName, 80);
  if (testName === null) return null;
  return { sensitivity: v.sensitivity, specificity: v.specificity, prevalence: v.prevalence, testName };
}

export function parseRocCurveInput(v: unknown): Parsed<RocCurveProps> | null {
  if (!isObj(v) || !Array.isArray(v.points) || v.points.length < 2 || v.points.length > 30) return null;
  const points: RocPoint[] = [];
  for (const p of v.points) {
    if (!isObj(p) || !isUnit(p.sensitivity) || !isUnit(p.specificity)) return null;
    const t = p.threshold;
    if (t !== undefined && !isFiniteNum(t) && !(typeof t === "string" && t.trim() && t.length <= 40)) return null;
    points.push(t === undefined ? { sensitivity: p.sensitivity, specificity: p.specificity } : { sensitivity: p.sensitivity, specificity: p.specificity, threshold: t as string | number });
  }
  // One test's thresholds trace a curve on which sensitivity never falls as
  // the false-positive rate rises; points that don't are not one ROC curve.
  if (!isMonotoneRoc(points)) return null;
  // At least two distinct operating points, or there is no curve to draw.
  if (new Set(points.map((p) => `${p.sensitivity}|${p.specificity}`)).size < 2) return null;
  const label = optStr(v.label, 120);
  if (label === null) return null;
  return { points, label };
}

export function parsePatientTimelineInput(v: unknown): Parsed<PatientTimelineProps> | null {
  if (!isObj(v) || !Array.isArray(v.events) || v.events.length < 1 || v.events.length > 40) return null;
  const events: TimelineEvent[] = [];
  const offsets = new Set<string>();
  for (const e of v.events) {
    if (!isObj(e) || typeof e.time !== "string") return null;
    const t = parseClinicalTime(e.time);
    if (!t) return null;
    offsets.add(t.offset);
    if (typeof e.category !== "string" || !(TIMELINE_CATEGORIES as readonly string[]).includes(e.category)) return null;
    const label = reqStr(e.label, 120);
    const detail = optStr(e.detail, 200);
    if (label === null || detail === null) return null;
    if (e.abnormal !== undefined && typeof e.abnormal !== "boolean") return null;
    events.push({ time: e.time, category: e.category as TimelineCategory, label, detail, abnormal: e.abnormal });
  }
  // Times are shown as recorded, so they must share one time zone (or none).
  if (offsets.size > 1) return null;
  const patientLabel = optStr(v.patientLabel, 80);
  if (patientLabel === null) return null;
  return { patientLabel, events };
}

export function parseCdsRuleInput(v: unknown): Parsed<CdsRuleProps> | null {
  if (!isObj(v) || (v.logic !== "all" && v.logic !== "any")) return null;
  const name = reqStr(v.name, 120);
  if (name === null || !Array.isArray(v.conditions) || v.conditions.length < 1 || v.conditions.length > 8) return null;
  if (!isObj(v.patient)) return null;
  const entries = Object.entries(v.patient);
  if (entries.length > 40) return null;
  const patient: Record<string, PatientValue> = {};
  for (const [k, val] of entries) {
    if (!k.trim() || k.length > 60 || k === "__proto__") return null;
    if (val !== null && !isFiniteNum(val) && !(typeof val === "string" && val.length <= 80)) return null;
    patient[k] = val as PatientValue;
  }
  const conditions: CdsCondition[] = [];
  for (const c of v.conditions) {
    if (!isObj(c)) return null;
    const label = reqStr(c.label, 120);
    const field = reqStr(c.field, 60);
    const unit = optStr(c.unit, 30);
    if (label === null || field === null || unit === null) return null;
    if (typeof c.operator !== "string" || !(CDS_OPERATORS as readonly string[]).includes(c.operator)) return null;
    const operator = c.operator as CdsOperator;
    const value = c.value;
    if (!isFiniteNum(value) && !(typeof value === "string" && value.trim() && value.length <= 60)) return null;
    // Text can only be equal or not equal; "> 'yes'" means nothing.
    if (typeof value === "string" && operator !== "=" && operator !== "!=") return null;
    // A recorded value must be the same kind as the value it is compared to.
    const pv = Object.prototype.hasOwnProperty.call(patient, field) ? patient[field] : null;
    if (pv !== null && typeof pv !== typeof value) return null;
    conditions.push({ label, field, operator, value, unit });
  }
  const action = optStr(v.action, 200);
  if (action === null) return null;
  return { name, logic: v.logic, conditions, patient, action };
}
