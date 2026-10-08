/* --------------------------------------------------------------------------
   Clinical informatics computation for the generative-UI figures.

   Diagnostic accuracy from a 2x2 table, predictive values across
   prevalence (Bayes' theorem), ROC area and Youden's J, a patient timeline's
   time axis, and a clinical decision support rule evaluated against one
   patient. The model supplies counts, rates, points, events or a rule; every
   number and every verdict a figure states is computed here. A ratio whose
   denominator is zero is `null` ("undefined"), never NaN or Infinity.
   -------------------------------------------------------------------------- */

/* -- Diagnostic accuracy (2x2) --------------------------------------------- */

export interface TwoByTwo {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

/** n / d, or null when d is zero (the ratio is undefined). */
export function ratio(n: number, d: number): number | null {
  return d === 0 ? null : n / d;
}

export interface DiagnosticMetrics {
  total: number;
  /** With the condition: TP + FN. */
  diseased: number;
  /** Without the condition: FP + TN. */
  healthy: number;
  testPositive: number;
  testNegative: number;
  sensitivity: number | null;
  specificity: number | null;
  ppv: number | null;
  npv: number | null;
  accuracy: number | null;
  prevalence: number | null;
  /** Sensitivity / (1 - specificity). */
  lrPositive: number | null;
  /** (1 - sensitivity) / specificity. */
  lrNegative: number | null;
}

export function diagnosticMetrics({ tp, fp, fn, tn }: TwoByTwo): DiagnosticMetrics {
  const diseased = tp + fn;
  const healthy = fp + tn;
  const total = diseased + healthy;
  const sensitivity = ratio(tp, diseased);
  const specificity = ratio(tn, healthy);
  return {
    total,
    diseased,
    healthy,
    testPositive: tp + fp,
    testNegative: fn + tn,
    sensitivity,
    specificity,
    ppv: ratio(tp, tp + fp),
    npv: ratio(tn, fn + tn),
    accuracy: ratio(tp + tn, total),
    prevalence: ratio(diseased, total),
    lrPositive: sensitivity === null || specificity === null ? null : ratio(sensitivity, 1 - specificity),
    lrNegative: sensitivity === null || specificity === null ? null : ratio(1 - sensitivity, specificity),
  };
}

/* -- Predictive values across prevalence ----------------------------------- */

/** PPV by Bayes' theorem: Se·p / (Se·p + (1 − Sp)(1 − p)). */
export function ppvAt(se: number, sp: number, p: number): number | null {
  return ratio(se * p, se * p + (1 - sp) * (1 - p));
}

/** NPV by Bayes' theorem: Sp(1 − p) / (Sp(1 − p) + (1 − Se)p). */
export function npvAt(se: number, sp: number, p: number): number | null {
  return ratio(sp * (1 - p), sp * (1 - p) + (1 - se) * p);
}

/** Expected counts when `n` people are tested (unrounded). */
export function naturalFrequencies(se: number, sp: number, p: number, n = 1000) {
  const diseased = n * p;
  const healthy = n - diseased;
  return { diseased, healthy, truePositive: diseased * se, falsePositive: healthy * (1 - sp) };
}

/** The x domain for the prevalence chart: the smallest of 20%, 50%, 100%
 *  that keeps the given prevalence in the left 40% of the plot. */
export function prevalenceDomain(p: number): number {
  return [0.2, 0.5, 1].find((m) => p * 2.5 <= m) ?? 1;
}

/** "About N of every 10 positive alerts are false positives", as a
 *  sentence fragment computed from the false-positive share (1 − PPV). */
export function falseAlertPhrase(ppv: number): string {
  const share = 1 - ppv;
  const n = Math.round(share * 10);
  if (n === 0) return "fewer than 1 of every 20 positive alerts is a false positive";
  if (n === 10) return "at least 19 of every 20 positive alerts are false positives";
  return n === 1 ? "about 1 of every 10 positive alerts is a false positive" : `about ${n} of every 10 positive alerts are false positives`;
}

/* -- ROC ------------------------------------------------------------------- */

export interface RocPoint {
  sensitivity: number;
  specificity: number;
  threshold?: string | number;
}

export interface RocResult {
  /** Supplied points as (fpr, tpr), sorted by FPR then TPR. */
  sorted: Array<RocPoint & { fpr: number; tpr: number }>;
  /** The polyline the AUC is computed over: anchored at (0,0) and (1,1). */
  curve: Array<{ fpr: number; tpr: number }>;
  auc: number;
  /** Supplied point with the largest Youden's J (first in FPR order on a tie). */
  best: RocPoint & { fpr: number; tpr: number; j: number };
}

/** Sorts by FPR (ties by TPR) -- the order a ROC curve is read in. */
export function sortRoc(points: ReadonlyArray<RocPoint>) {
  return points
    .map((p) => ({ ...p, fpr: 1 - p.specificity, tpr: p.sensitivity }))
    .sort((a, b) => a.fpr - b.fpr || a.tpr - b.tpr);
}

/** True when sensitivity never falls as the false-positive rate rises:
 *  points from one test's thresholds always satisfy this. */
export function isMonotoneRoc(points: ReadonlyArray<RocPoint>): boolean {
  const s = sortRoc(points);
  return s.every((p, i) => i === 0 || p.tpr >= s[i - 1]!.tpr);
}

export function rocCurve(points: ReadonlyArray<RocPoint>): RocResult {
  const sorted = sortRoc(points);
  const curve = sorted.map(({ fpr, tpr }) => ({ fpr, tpr }));
  if (curve[0]!.fpr !== 0 || curve[0]!.tpr !== 0) curve.unshift({ fpr: 0, tpr: 0 });
  const last = curve[curve.length - 1]!;
  if (last.fpr !== 1 || last.tpr !== 1) curve.push({ fpr: 1, tpr: 1 });
  let auc = 0;
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1]!;
    const b = curve[i]!;
    auc += ((a.tpr + b.tpr) / 2) * (b.fpr - a.fpr);
  }
  let best = { ...sorted[0]!, j: sorted[0]!.sensitivity + sorted[0]!.specificity - 1 };
  for (const p of sorted) {
    const j = p.sensitivity + p.specificity - 1;
    if (j > best.j + 1e-12) best = { ...p, j };
  }
  return { sorted, curve, auc, best };
}

/* -- Patient timeline ------------------------------------------------------ */

export const TIMELINE_CATEGORIES = ["encounter", "vital", "lab", "medication", "procedure", "order", "note"] as const;
export type TimelineCategory = (typeof TIMELINE_CATEGORIES)[number];

export interface ClinicalTime {
  /** Wall-clock time as written, encoded as a UTC epoch (so it is shown
   *  exactly as the chart recorded it, whatever the viewer's time zone). */
  at: number;
  hasTime: boolean;
  /** "Z", "+02:00", or "" when none was given. */
  offset: string;
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/** Parses an ISO 8601 date ("2026-03-03") or date-time
 *  ("2026-03-03T08:40", seconds and an offset optional). Returns null for
 *  anything else, including impossible dates such as 2026-02-30. */
export function parseClinicalTime(s: string): ClinicalTime | null {
  const m = ISO.exec(s.trim());
  if (!m) return null;
  const [y, mo, d, h = "0", mi = "0", sec = "0"] = [m[1]!, m[2]!, m[3]!, m[4], m[5], m[6]];
  const Y = Number(y), M = Number(mo), D = Number(d), H = Number(h), MI = Number(mi), S = Number(sec);
  if (M < 1 || M > 12 || D < 1 || H > 23 || MI > 59 || S > 59) return null;
  const at = Date.UTC(Y, M - 1, D, H, MI, S);
  const check = new Date(at);
  if (check.getUTCFullYear() !== Y || check.getUTCMonth() !== M - 1 || check.getUTCDate() !== D) return null;
  return { at, hasTime: m[4] !== undefined, offset: m[7] ?? "" };
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (n: number) => String(n).padStart(2, "0");

export function formatDay(at: number, withYear = false): string {
  const d = new Date(at);
  return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}${withYear ? `, ${d.getUTCFullYear()}` : ""}`;
}

export function formatClock(at: number): string {
  const d = new Date(at);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

export function formatWhen(t: ClinicalTime, withYear = false): string {
  return t.hasTime ? `${formatDay(t.at, withYear)} ${formatClock(t.at)}` : formatDay(t.at, withYear);
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "3 d 2 h 50 min", dropping zero units; "0 min" for no time at all. */
export function formatDuration(ms: number): string {
  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  const mins = Math.round((ms % HOUR) / MIN);
  const parts = [days ? `${days} d` : "", hours ? `${hours} h` : "", mins ? `${mins} min` : ""].filter(Boolean);
  return parts.length ? parts.join(" ") : "0 min";
}

export type TickUnit = "minute" | "day" | "month" | "year";
interface TickStep {
  unit: TickUnit;
  /** minutes for "minute", days for "day", months for "month", years for "year" */
  n: number;
}

const STEPS: TickStep[] = [
  ...[15, 30, 60, 120, 180, 360, 720].map((n) => ({ unit: "minute" as const, n })),
  ...[1, 2, 7, 14].map((n) => ({ unit: "day" as const, n })),
  ...[1, 2, 3, 6].map((n) => ({ unit: "month" as const, n })),
  ...[1, 2, 5, 10, 20, 50].map((n) => ({ unit: "year" as const, n })),
];

// 1970-01-05 was a Monday: weekly ticks fall on Mondays.
const MONDAY = 4 * DAY;

function floorTo(t: number, s: TickStep): number {
  const d = new Date(t);
  switch (s.unit) {
    case "minute": return Math.floor(t / (s.n * MIN)) * s.n * MIN;
    case "day": {
      const size = s.n * DAY;
      const origin = s.n >= 7 ? MONDAY : 0;
      return Math.floor((t - origin) / size) * size + origin;
    }
    case "month": {
      const m = d.getUTCFullYear() * 12 + d.getUTCMonth();
      const fm = Math.floor(m / s.n) * s.n;
      return Date.UTC(Math.floor(fm / 12), fm % 12, 1);
    }
    case "year": return Date.UTC(Math.floor(d.getUTCFullYear() / s.n) * s.n, 0, 1);
  }
}

function addStep(t: number, s: TickStep): number {
  const d = new Date(t);
  switch (s.unit) {
    case "minute": return t + s.n * MIN;
    case "day": return t + s.n * DAY;
    case "month": return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + s.n, 1);
    case "year": return Date.UTC(d.getUTCFullYear() + s.n, 0, 1);
  }
}

export interface TimeAxis {
  lo: number;
  hi: number;
  ticks: number[];
  step: TickStep;
}

/** A readable time axis over [min, max]: the finest step that spans the
 *  range in at most `maxIntervals` steps, the domain snapped outward to
 *  step boundaries. A single instant gets at least a six-hour window. */
export function timeAxis(min: number, max: number, { maxIntervals = 4, datesOnly = false } = {}): TimeAxis {
  const hiT = max > min ? max : min + 1;
  for (const step of STEPS) {
    // Date-only events never get a clock-time axis; one instant gets >= 6 h.
    if (step.unit === "minute" && (datesOnly || (min === max && step.n < 360))) continue;
    const lo = floorTo(min, step);
    const ticks = [lo];
    while (ticks[ticks.length - 1]! < hiT && ticks.length <= maxIntervals + 1) ticks.push(addStep(ticks[ticks.length - 1]!, step));
    if (ticks.length - 1 <= maxIntervals) return { lo, hi: ticks[ticks.length - 1]!, ticks, step };
  }
  const step = STEPS[STEPS.length - 1]!;
  const lo = floorTo(min, step);
  return { lo, hi: addStep(lo, step), ticks: [lo, addStep(lo, step)], step };
}

/** Tick label: a clock time for sub-day steps (with the date on the first
 *  tick and wherever the day changes), a date for day steps, a month or a
 *  year for longer ones. */
export function tickLabel(axis: TimeAxis, i: number): { main: string; sub?: string } {
  const t = axis.ticks[i]!;
  const d = new Date(t);
  const prev = i > 0 ? new Date(axis.ticks[i - 1]!) : null;
  switch (axis.step.unit) {
    case "minute": {
      const newDay = !prev || prev.getUTCDate() !== d.getUTCDate() || prev.getUTCMonth() !== d.getUTCMonth();
      return { main: formatClock(t), sub: newDay ? formatDay(t) : undefined };
    }
    case "day": {
      const newYear = !prev || prev.getUTCFullYear() !== d.getUTCFullYear();
      return { main: formatDay(t), sub: i === 0 || newYear ? String(d.getUTCFullYear()) : undefined };
    }
    case "month": {
      const newYear = !prev || prev.getUTCFullYear() !== d.getUTCFullYear();
      return { main: MON[d.getUTCMonth()]!, sub: newYear ? String(d.getUTCFullYear()) : undefined };
    }
    case "year": return { main: String(d.getUTCFullYear()) };
  }
}

/* -- Clinical decision support rule ----------------------------------------- */

export type CdsOperator = ">" | ">=" | "<" | "<=" | "=" | "!=";
export const CDS_OPERATORS: readonly CdsOperator[] = [">", ">=", "<", "<=", "=", "!="];
export const OPERATOR_SYMBOL: Record<CdsOperator, string> = { ">": ">", ">=": "≥", "<": "<", "<=": "≤", "=": "=", "!=": "≠" };

export interface CdsCondition {
  label: string;
  field: string;
  operator: CdsOperator;
  value: number | string;
  unit?: string;
}

export type PatientValue = number | string | null;
export type ConditionResult = "met" | "not-met" | "missing";

const norm = (s: string) => s.trim().toLowerCase();

/** One condition against one patient. A field that is absent, or recorded
 *  as null, is "missing". Text compares case-insensitively. */
export function evaluateCondition(c: CdsCondition, patient: Readonly<Record<string, PatientValue>>): ConditionResult {
  const v = Object.prototype.hasOwnProperty.call(patient, c.field) ? patient[c.field] : null;
  if (v === null || v === undefined) return "missing";
  let ok: boolean;
  if (typeof v === "number" && typeof c.value === "number") {
    const x = c.value;
    ok = { ">": v > x, ">=": v >= x, "<": v < x, "<=": v <= x, "=": v === x, "!=": v !== x }[c.operator];
  } else if (typeof v === "string" && typeof c.value === "string") {
    if (c.operator !== "=" && c.operator !== "!=") return "missing";
    ok = c.operator === "=" ? norm(v) === norm(c.value) : norm(v) !== norm(c.value);
  } else {
    // A number compared with text cannot be evaluated (the parser rejects it).
    return "missing";
  }
  return ok ? "met" : "not-met";
}

export type RuleOutcome =
  /** The rule fires. */
  | "fires"
  /** It does not fire, and no missing value could change that. */
  | "does-not-fire"
  /** It does not fire now, but would if the missing value(s) were met. */
  | "blocked-by-missing";

export interface RuleEvaluation {
  results: ConditionResult[];
  met: number;
  notMet: number;
  missing: number;
  outcome: RuleOutcome;
}

/** "all": fires only when every condition is met; a missing value counts as
 *  not met, so the rule stays silent until it is recorded.
 *  "any": fires when at least one condition is met; missing values are
 *  skipped, so a silent rule may only be silent for lack of data. */
export function evaluateRule(
  logic: "all" | "any",
  conditions: ReadonlyArray<CdsCondition>,
  patient: Readonly<Record<string, PatientValue>>,
): RuleEvaluation {
  const results = conditions.map((c) => evaluateCondition(c, patient));
  const met = results.filter((r) => r === "met").length;
  const notMet = results.filter((r) => r === "not-met").length;
  const missing = results.length - met - notMet;
  let outcome: RuleOutcome;
  if (logic === "all") outcome = met === results.length ? "fires" : notMet > 0 || missing === 0 ? "does-not-fire" : "blocked-by-missing";
  else outcome = met > 0 ? "fires" : missing > 0 ? "blocked-by-missing" : "does-not-fire";
  return { results, met, notMet, missing, outcome };
}

/* -- Formatting -------------------------------------------------------------- */

/** 0.8512 -> "85.1%"; null -> "undefined". */
export function fmtPct(v: number | null, digits = 1): string {
  return v === null ? "undefined" : `${(v * 100).toFixed(digits)}%`;
}

/** A prevalence or rate without trailing zeros: 0.02 -> "2%", 0.005 -> "0.5%". */
export function fmtRate(v: number): string {
  return `${Number((v * 100).toFixed(2))}%`;
}

/** Likelihood ratios to two decimals; null -> "undefined". */
export function fmtRatio(v: number | null): string {
  return v === null ? "undefined" : v.toFixed(2);
}

export function fmtCount(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}
