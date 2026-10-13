/* --------------------------------------------------------------------------
   Macroeconomics computation for the generative-UI figures.

   The diagrams are qualitative -- intro macro draws stylised straight-line
   curves, and so do these -- but the qualitative OUTCOME of a shift (does
   the price level rise or fall?) is computed from the geometry, never
   taken from the model's prose. A model that says "AD shifts right, so
   output falls" cannot get that past this file.
   -------------------------------------------------------------------------- */

export type MacroModelKind = "ad-as" | "loanable-funds" | "money-market";
export type ShiftDirection = "left" | "right";

/** A curve in model space, where both axes run 0..10. Vertical curves
 *  (LRAS, a fixed money supply) have `vertical` set and use `x`. */
export interface Curve {
  id: string;
  label: string;
  slope: number;
  intercept: number;
  vertical?: number;
  /** Categorical slot (1-based) so a curve keeps its colour everywhere. */
  slot: 1 | 2 | 3;
}

export interface MacroModelSpec {
  kind: MacroModelKind;
  title: string;
  xAxis: string;
  yAxis: string;
  xSymbol: string;
  ySymbol: string;
  curves: Curve[];
  /** The two curves whose intersection is the equilibrium. */
  equilibrium: [string, string];
  /** The equilibrium in the long run, when the model has one (LRAS). */
}

export const MACRO_MODELS: Record<MacroModelKind, MacroModelSpec> = {
  "ad-as": {
    kind: "ad-as",
    title: "Aggregate demand and aggregate supply",
    xAxis: "Real GDP",
    yAxis: "Price level",
    xSymbol: "Y",
    ySymbol: "P",
    curves: [
      { id: "AD", label: "AD", slope: -0.9, intercept: 9.5, slot: 1 },
      { id: "SRAS", label: "SRAS", slope: 0.9, intercept: 0.5, slot: 2 },
      { id: "LRAS", label: "LRAS", slope: 0, intercept: 0, vertical: 5, slot: 3 },
    ],
    equilibrium: ["AD", "SRAS"],
  },
  "loanable-funds": {
    kind: "loanable-funds",
    title: "The market for loanable funds",
    xAxis: "Quantity of loanable funds",
    yAxis: "Real interest rate",
    xSymbol: "Q",
    ySymbol: "r",
    curves: [
      { id: "D", label: "Demand (investment)", slope: -0.9, intercept: 9.5, slot: 1 },
      { id: "S", label: "Supply (saving)", slope: 0.9, intercept: 0.5, slot: 2 },
    ],
    equilibrium: ["D", "S"],
  },
  "money-market": {
    kind: "money-market",
    title: "The money market",
    xAxis: "Quantity of money",
    yAxis: "Nominal interest rate",
    xSymbol: "M",
    ySymbol: "i",
    curves: [
      { id: "MD", label: "Money demand", slope: -0.9, intercept: 9.5, slot: 1 },
      { id: "MS", label: "Money supply", slope: 0, intercept: 0, vertical: 5, slot: 2 },
    ],
    equilibrium: ["MD", "MS"],
  },
};

/** How far one shift moves a curve, in model units along the x axis. */
export const SHIFT_DISTANCE = 1.6;

export function shiftCurve(curve: Curve, direction: ShiftDirection): Curve {
  const dx = direction === "right" ? SHIFT_DISTANCE : -SHIFT_DISTANCE;
  if (curve.vertical !== undefined) return { ...curve, vertical: curve.vertical + dx };
  // y = m(x - dx) + b  =>  intercept moves by -m*dx
  return { ...curve, intercept: curve.intercept - curve.slope * dx };
}

export function intersect(a: Curve, b: Curve): { x: number; y: number } | null {
  if (a.vertical !== undefined && b.vertical !== undefined) return null;
  if (a.vertical !== undefined) return { x: a.vertical, y: b.slope * a.vertical + b.intercept };
  if (b.vertical !== undefined) return { x: b.vertical, y: a.slope * b.vertical + a.intercept };
  if (a.slope === b.slope) return null;
  const x = (b.intercept - a.intercept) / (a.slope - b.slope);
  return { x, y: a.slope * x + a.intercept };
}

export type Movement = "rises" | "falls" | "unchanged";

function movement(before: number, after: number): Movement {
  if (Math.abs(after - before) < 1e-9) return "unchanged";
  return after > before ? "rises" : "falls";
}

export interface ShiftOutcome {
  before: { x: number; y: number };
  after: { x: number; y: number };
  curvesAfter: Curve[];
  xMovement: Movement;
  yMovement: Movement;
}

/** Applies every shift, then compares the short-run equilibrium before and
 *  after. A shift naming a curve the model doesn't have is ignored (the
 *  caller validates names first). */
export function applyShifts(
  spec: MacroModelSpec,
  shifts: ReadonlyArray<{ curve: string; direction: ShiftDirection }>,
): ShiftOutcome | null {
  const byId = new Map(spec.curves.map((c) => [c.id, c]));
  const after = new Map(byId);
  for (const s of shifts) {
    const current = after.get(s.curve);
    if (current) after.set(s.curve, shiftCurve(current, s.direction));
  }
  const [p, q] = spec.equilibrium;
  const e1 = intersect(byId.get(p)!, byId.get(q)!);
  const e2 = intersect(after.get(p)!, after.get(q)!);
  if (!e1 || !e2) return null;
  return {
    before: e1,
    after: e2,
    curvesAfter: [...after.values()],
    xMovement: movement(e1.x, e2.x),
    yMovement: movement(e1.y, e2.y),
  };
}

/* -- Spending multiplier --------------------------------------------------- */

export interface MultiplierResult {
  multiplier: number;
  total: number;
  /** Each round's new spending: initial * mpc^k. */
  rounds: number[];
  /** Running total after each round. */
  cumulative: number[];
}

export function spendingMultiplier(mpc: number, initial: number, roundCount: number): MultiplierResult {
  const rounds: number[] = [];
  const cumulative: number[] = [];
  let running = 0;
  for (let k = 0; k < roundCount; k++) {
    const r = initial * mpc ** k;
    running += r;
    rounds.push(r);
    cumulative.push(running);
  }
  const multiplier = 1 / (1 - mpc);
  return { multiplier, total: initial * multiplier, rounds, cumulative };
}

/* -- GDP by expenditure ---------------------------------------------------- */

export interface GdpComponents {
  consumption: number;
  investment: number;
  government: number;
  netExports: number;
}

export function gdpTotal(c: GdpComponents): number {
  return c.consumption + c.investment + c.government + c.netExports;
}

/** Compact money formatting for labels: 18,350 -> "18,350"; keeps one
 *  decimal only when the value has one. */
export function formatAmount(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return rounded.toLocaleString("en-US", { maximumFractionDigits: 1 });
}
