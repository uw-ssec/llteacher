/* --------------------------------------------------------------------------
   Runtime validation for the measurement figure tools (run chart, System
   Usability Scale, adoption curve).

   Same deny-by-default rule as toolInputs.clinical.ts: every field is checked
   for type AND meaning -- a numerator larger than its denominator, run chart
   points that mix values and rates, a "change" at a point that does not
   exist, a SUS response of 0 or 6 or a respondent with nine answers, adoption
   counts that fall over time or exceed the staff. Anything wrong returns
   null and the registry shows nothing.
   -------------------------------------------------------------------------- */

import type { AdoptionCurveProps, AdoptionPoint } from "./renderers/informatics/AdoptionCurve";
import type { RunChartPoint, RunChartProps } from "./renderers/informatics/RunChart";
import type { UsabilityScoreProps } from "./renderers/informatics/UsabilityScore";

type Obj = Record<string, unknown>;
type Parsed<P> = Omit<P, "isPartial">;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1e9;
const optStr = (v: unknown, max = 200): string | undefined | null =>
  v === undefined ? undefined : typeof v === "string" && v.trim() && v.length <= max ? v : null;
const reqStr = (v: unknown, max = 200): string | null => (typeof v === "string" && v.trim() && v.length <= max ? v : null);

/** Labels identify points (a change is placed by label), so they must be unique. */
const uniqueLabels = (labels: string[]) => new Set(labels).size === labels.length;

export function parseRunChartInput(v: unknown): Parsed<RunChartProps> | null {
  if (!isObj(v)) return null;
  const measure = reqStr(v.measure, 100);
  if (measure === null) return null;
  if (!Array.isArray(v.points) || v.points.length < 10 || v.points.length > 60) return null;

  const first = v.points[0];
  const rate = isObj(first) && first.numerator !== undefined;
  const points: RunChartPoint[] = [];
  for (const p of v.points) {
    if (!isObj(p)) return null;
    const label = reqStr(p.label, 24);
    if (label === null) return null;
    if (rate) {
      // Every point a rate: whole counts, 0 <= numerator <= denominator, denominator > 0.
      if (p.value !== undefined || !isCount(p.numerator) || !isCount(p.denominator)) return null;
      if (p.denominator === 0 || p.numerator > p.denominator) return null;
      points.push({ label, numerator: p.numerator, denominator: p.denominator });
    } else {
      if (p.numerator !== undefined || p.denominator !== undefined) return null;
      if (!isFiniteNum(p.value) || Math.abs(p.value) > 1e7) return null;
      points.push({ label, value: p.value });
    }
  }
  if (!uniqueLabels(points.map((p) => p.label))) return null;

  // Rate points are percentages by construction; any other unit would contradict them.
  const unit = optStr(v.unit, 40);
  if (unit === null || (rate && unit !== undefined && unit !== "%")) return null;

  const improvement = v.improvement;
  if (improvement !== undefined && improvement !== "up" && improvement !== "down") return null;

  const changeAfter = optStr(v.changeAfter, 24);
  const changeLabel = optStr(v.changeLabel, 60);
  if (changeAfter === null || changeLabel === null) return null;
  if (changeAfter !== undefined && !points.some((p) => p.label === changeAfter)) return null;
  // A name for a change with no place on the chart would be stated nowhere.
  if (changeLabel !== undefined && changeAfter === undefined) return null;

  const bc = v.baselineCount;
  if (bc !== undefined && (!Number.isInteger(bc) || (bc as number) < 8 || (bc as number) > points.length)) return null;

  return {
    measure,
    unit: rate ? undefined : unit,
    points,
    improvement: improvement as RunChartProps["improvement"],
    changeAfter,
    changeLabel,
    baselineCount: bc as number | undefined,
  };
}

export function parseUsabilityScoreInput(v: unknown): Parsed<UsabilityScoreProps> | null {
  if (!isObj(v)) return null;
  const systemName = reqStr(v.systemName, 80);
  if (systemName === null) return null;
  if (!Array.isArray(v.respondents) || v.respondents.length < 1 || v.respondents.length > 50) return null;
  const respondents: number[][] = [];
  for (const r of v.respondents) {
    if (!Array.isArray(r) || r.length !== 10) return null;
    if (!r.every((x) => Number.isInteger(x) && x >= 1 && x <= 5)) return null;
    respondents.push([...(r as number[])]);
  }
  return { systemName, respondents };
}

export function parseAdoptionCurveInput(v: unknown): Parsed<AdoptionCurveProps> | null {
  if (!isObj(v)) return null;
  const innovation = reqStr(v.innovation, 80);
  if (innovation === null) return null;
  const staffCount = v.staffCount;
  if (!isCount(staffCount) || staffCount < 1 || staffCount > 1e6) return null;
  const staffLabel = optStr(v.staffLabel, 30);
  if (staffLabel === null) return null;

  // Exactly one of: a count now, or a series ending now.
  const hasCount = v.adoptedCount !== undefined;
  const hasSeries = v.series !== undefined;
  if (hasCount === hasSeries) return null;

  if (hasCount) {
    if (!isCount(v.adoptedCount) || v.adoptedCount > staffCount) return null;
    return { innovation, staffCount, adoptedCount: v.adoptedCount, staffLabel };
  }

  if (!Array.isArray(v.series) || v.series.length < 2 || v.series.length > 40) return null;
  const series: AdoptionPoint[] = [];
  let prev = 0;
  for (const p of v.series) {
    if (!isObj(p)) return null;
    const label = reqStr(p.label, 24);
    if (label === null || !isCount(p.adoptedCount)) return null;
    // Cumulative adoption cannot fall, and cannot exceed the staff.
    if (p.adoptedCount < prev || p.adoptedCount > staffCount) return null;
    prev = p.adoptedCount;
    series.push({ label, adoptedCount: p.adoptedCount });
  }
  if (!uniqueLabels(series.map((p) => p.label))) return null;
  return { innovation, staffCount, series, staffLabel };
}
