/* --------------------------------------------------------------------------
   Measurement computation for the clinical informatics figures.

   A quality-improvement run chart (median and the shift and trend rules of
   Perla, Provost & Murray, BMJ Qual Saf 2011), the System Usability Scale
   (Brooke, 1996) and Rogers' diffusion of innovations applied to a staff
   rollout. The model supplies the data; the reference content (the ten SUS
   statements, the adopter categories and their shares) lives here, and every
   number, signal and category a figure states is computed here.
   -------------------------------------------------------------------------- */

/* -- Shared ---------------------------------------------------------------- */

export function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Up to two decimals, no trailing zeros, thousands separated: 1234.5 -> "1,234.5". */
export function fmtNum(v: number): string {
  return Number(v.toFixed(2)).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** One decimal, always: 92.46 -> "92.5". */
export const fmt1 = (v: number): string => v.toFixed(1);

/* -- Run chart ---------------------------------------------------------------- */

export type Side = "above" | "below" | "on";
export type Direction = "up" | "down";

export interface RunSignal {
  kind: "shift" | "trend";
  /** Shift: up = above the median. Trend: up = increasing. */
  direction: Direction;
  /** Indices of the points that count toward the signal, in order. */
  points: number[];
}

const EPS = 1e-9;

export function sideOf(v: number, m: number): Side {
  const tol = EPS * Math.max(1, Math.abs(m));
  return v > m + tol ? "above" : v < m - tol ? "below" : "on";
}

/**
 * Shifts: `minLength` or more consecutive points all above or all below the
 * median. A point exactly on the median neither counts nor breaks the run.
 */
export function findShifts(values: readonly number[], m: number, minLength = 6): RunSignal[] {
  const out: RunSignal[] = [];
  let run: number[] = [];
  let side: Side = "on";
  const close = () => {
    if (run.length >= minLength) out.push({ kind: "shift", direction: side === "above" ? "up" : "down", points: run });
  };
  values.forEach((v, i) => {
    const s = sideOf(v, m);
    if (s === "on") return;
    if (s !== side) {
      close();
      run = [];
      side = s;
    }
    run.push(i);
  });
  close();
  return out;
}

/**
 * Trends: `minLength` or more consecutive points all increasing or all
 * decreasing. A value equal to the one before it neither counts nor breaks
 * the trend (only the first of a repeat counts). Two trends may share their
 * turning point.
 */
export function findTrends(values: readonly number[], minLength = 5): RunSignal[] {
  const kept: number[] = [];
  values.forEach((v, i) => {
    const prev = kept.length ? values[kept[kept.length - 1]!]! : null;
    if (prev === null || Math.abs(v - prev) > EPS * Math.max(1, Math.abs(prev))) kept.push(i);
  });
  const out: RunSignal[] = [];
  let start = 0;
  for (let k = 1; k <= kept.length; k++) {
    const dir = (a: number) => (values[kept[a]!]! > values[kept[a - 1]!]! ? "up" : "down");
    // Close the stretch [start, k-1] when the direction changes or the data end.
    if (k === kept.length || (k - start >= 2 && dir(k) !== dir(k - 1))) {
      const pts = kept.slice(start, k);
      if (pts.length >= minLength) out.push({ kind: "trend", direction: dir(start + 1), points: pts });
      start = k - 1;
    }
  }
  return out;
}

export interface RunChartAnalysis {
  median: number;
  baselineCount: number;
  sides: Side[];
  signals: RunSignal[];
}

/** Median of the first `baselineCount` points (all by default), then the rules over every point. */
export function analyseRunChart(values: readonly number[], baselineCount = values.length): RunChartAnalysis {
  const m = median(values.slice(0, baselineCount));
  const signals = [...findShifts(values, m), ...findTrends(values)].sort(
    (a, b) => a.points[0]! - b.points[0]! || (a.kind === "shift" ? -1 : 1),
  );
  return { median: m, baselineCount, sides: values.map((v) => sideOf(v, m)), signals };
}

/** Whether a signal runs in the better direction; null when no direction was given. */
export function signalFavourable(s: RunSignal, improvement?: Direction): boolean | null {
  return improvement === undefined ? null : s.direction === improvement;
}

/** numerator / denominator as a percentage. */
export const ratePct = (numerator: number, denominator: number): number => (numerator / denominator) * 100;

/** Rounded tick values spanning [lo, hi] (about four intervals). */
export function niceTicks(lo: number, hi: number): number[] {
  const span = hi - lo || Math.abs(hi) || 1;
  const raw = span / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((x) => x * mag).find((s) => s >= raw)!;
  const start = Math.floor(lo / step + EPS) * step;
  const ticks: number[] = [];
  for (let t = start; t <= hi + step * 0.999; t += step) ticks.push(Math.round(t * 1e6) / 1e6);
  return ticks;
}

/* -- System Usability Scale ------------------------------------------------------ */

/** Brooke (1996), verbatim. Odd items are positively worded, even items negatively. */
export const SUS_ITEMS = [
  "I think that I would like to use this system frequently.",
  "I found the system unnecessarily complex.",
  "I thought the system was easy to use.",
  "I think that I would need the support of a technical person to be able to use this system.",
  "I found the various functions in this system were well integrated.",
  "I thought there was too much inconsistency in this system.",
  "I would imagine that most people would learn to use this system very quickly.",
  "I found the system very cumbersome to use.",
  "I felt very confident using the system.",
  "I needed to learn a lot of things before I could get going with this system.",
] as const;

/** Short names for the per-item chart. */
export const SUS_SHORT = [
  "Would use often",
  "Unnecessarily complex",
  "Easy to use",
  "Needs tech support",
  "Well integrated",
  "Inconsistent",
  "Quick to learn",
  "Cumbersome",
  "Felt confident",
  "Much to learn first",
] as const;

/** The commonly cited average SUS score across studies (Sauro). */
export const SUS_AVERAGE = 68;

/**
 * Bangor, Kortum & Miller (2009): the mean SUS score of respondents who chose
 * each adjective on a seven-point rating added to the SUS.
 */
export const SUS_ADJECTIVES = [
  { adjective: "Worst imaginable", mean: 12.5 },
  { adjective: "Awful", mean: 20.3 },
  { adjective: "Poor", mean: 35.7 },
  { adjective: "OK", mean: 50.9 },
  { adjective: "Good", mean: 71.4 },
  { adjective: "Excellent", mean: 85.5 },
  { adjective: "Best imaginable", mean: 90.9 },
] as const;

/** Item i (0-based) contributes response − 1 when odd-numbered (1, 3, …), 5 − response when even. */
export const susContribution = (i: number, response: number): number => (i % 2 === 0 ? response - 1 : 5 - response);

/** One respondent's SUS score, 0–100. */
export function susScore(responses: readonly number[]): number {
  return responses.reduce((sum, r, i) => sum + susContribution(i, r), 0) * 2.5;
}

export interface SusSummary {
  scores: number[];
  n: number;
  mean: number;
  min: number;
  max: number;
  /** Mean raw response (1–5) per item. */
  itemMeanResponse: number[];
  /** Mean contribution (0–4, higher is better) per item. */
  itemMeanContribution: number[];
  /** 1-based item numbers with the lowest mean contribution (ties kept). */
  lowestItems: number[];
}

export function susSummary(respondents: readonly (readonly number[])[]): SusSummary {
  const n = respondents.length;
  const scores = respondents.map(susScore);
  const itemMeanResponse = SUS_ITEMS.map((_, i) => respondents.reduce((s, r) => s + r[i]!, 0) / n);
  const itemMeanContribution = SUS_ITEMS.map((_, i) => respondents.reduce((s, r) => s + susContribution(i, r[i]!), 0) / n);
  // Compare at the precision shown (two decimals) so "tied" means tied on screen.
  const shown = itemMeanContribution.map((c) => Math.round(c * 100));
  const low = Math.min(...shown);
  return {
    scores,
    n,
    mean: scores.reduce((a, b) => a + b, 0) / n,
    min: Math.min(...scores),
    max: Math.max(...scores),
    itemMeanResponse,
    itemMeanContribution,
    lowestItems: shown.flatMap((c, i) => (c === low ? [i + 1] : [])),
  };
}

/** The Bangor adjective whose mean score is nearest; an exact midpoint goes to the lower one. */
export function closestAdjective(score: number): (typeof SUS_ADJECTIVES)[number] {
  let best: (typeof SUS_ADJECTIVES)[number] = SUS_ADJECTIVES[0];
  for (const a of SUS_ADJECTIVES) if (Math.abs(a.mean - score) < Math.abs(best.mean - score) - EPS) best = a;
  return best;
}

/* -- Diffusion of innovations (Rogers) ---------------------------------------- */

export interface AdopterCategory {
  name: string;
  /** Share of all adopters, percent. */
  share: number;
  /** Cumulative percent at the category's start and end. */
  from: number;
  to: number;
  /** Standard deviations from the mean adoption time at its edges. */
  zFrom: number;
  zTo: number;
}

/** Rogers' idealised adopter categories, cut at 1 and 2 SD from the mean. */
export const ADOPTER_CATEGORIES: readonly AdopterCategory[] = [
  { name: "Innovators", share: 2.5, from: 0, to: 2.5, zFrom: -Infinity, zTo: -2 },
  { name: "Early adopters", share: 13.5, from: 2.5, to: 16, zFrom: -2, zTo: -1 },
  { name: "Early majority", share: 34, from: 16, to: 50, zFrom: -1, zTo: 0 },
  { name: "Late majority", share: 34, from: 50, to: 84, zFrom: 0, zTo: 1 },
  { name: "Laggards", share: 16, from: 84, to: 100, zFrom: 1, zTo: Infinity },
];

/** The cumulative marks between categories, and what reaching each means. */
export const ADOPTION_MARKS = [
  { pct: 2.5, meaning: "innovators done" },
  { pct: 16, meaning: "early adopters done" },
  { pct: 50, meaning: "early majority done" },
  { pct: 84, meaning: "late majority done" },
] as const;

/** The category the next adopter falls in at `pct` adopted; null once everyone has adopted. */
export function nextCategoryIndex(pct: number): number | null {
  if (pct >= 100) return null;
  return ADOPTER_CATEGORIES.findIndex((c) => pct < c.to);
}

/** Percent adopted, rounded DOWN to one decimal so a value never reads as past a mark it has not reached. */
export function fmtAdoptedPct(pct: number): string {
  return `${Number((Math.floor(pct * 10 + EPS) / 10).toFixed(1))}%`;
}

export const normalPdf = (z: number): number => Math.exp(-(z * z) / 2) / Math.sqrt(2 * Math.PI);

/** Standard normal CDF (Abramowitz & Stegun 7.1.26, |error| < 1.5e-7). */
export function normalCdf(z: number): number {
  if (z === Infinity) return 1;
  if (z === -Infinity) return 0;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/** Inverse of normalCdf by bisection on [-8, 8]. */
function normalQuantile(p: number): number {
  let lo = -8;
  let hi = 8;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (normalCdf(mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Where `pct` adopted falls on the bell curve, in SD. Within a category the
 * area under the curve is split in proportion, so the shaded share of each
 * category matches the share of it that has adopted.
 */
export function adoptionZ(pct: number): number {
  if (pct <= 0) return -Infinity;
  if (pct >= 100) return Infinity;
  const c = ADOPTER_CATEGORIES[nextCategoryIndex(pct)!]!;
  const frac = (pct - c.from) / (c.to - c.from);
  const a = normalCdf(c.zFrom);
  return normalQuantile(a + frac * (normalCdf(c.zTo) - a));
}

/** Index of the first observation at or past `mark` percent, or null. */
export function firstReached(pcts: readonly number[], mark: number): number | null {
  const i = pcts.findIndex((p) => p >= mark - EPS);
  return i < 0 ? null : i;
}
