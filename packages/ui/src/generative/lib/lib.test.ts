import { describe, it, expect } from "vitest";
import { MACRO_MODELS, applyShifts, gdpTotal, intersect, spendingMultiplier } from "./econ";

describe("macro models", () => {
  it("starts AD-AS in long-run equilibrium on LRAS", () => {
    const spec = MACRO_MODELS["ad-as"];
    const e = intersect(spec.curves[0]!, spec.curves[1]!)!;
    expect(e.x).toBeCloseTo(5);
    expect(e.y).toBeCloseTo(5);
    expect(spec.curves[2]!.vertical).toBe(5);
  });

  it.each([
    ["ad-as", "AD", "right", "rises", "rises"],
    ["ad-as", "AD", "left", "falls", "falls"],
    ["ad-as", "SRAS", "left", "falls", "rises"], // supply shock: stagflation
    ["ad-as", "SRAS", "right", "rises", "falls"],
    ["loanable-funds", "S", "right", "rises", "falls"], // more saving: r falls, Q rises
    ["loanable-funds", "D", "right", "rises", "rises"],
    ["money-market", "MS", "right", "rises", "falls"], // expansionary policy: i falls
    ["money-market", "MD", "right", "unchanged", "rises"],
  ] as const)("%s: %s shifts %s -> quantity %s, price/rate %s", (kind, curve, direction, x, y) => {
    const outcome = applyShifts(MACRO_MODELS[kind], [{ curve, direction }])!;
    expect(outcome.xMovement).toBe(x);
    expect(outcome.yMovement).toBe(y);
  });

  it("ignores LRAS for the short-run equilibrium but moves the curve", () => {
    const outcome = applyShifts(MACRO_MODELS["ad-as"], [{ curve: "LRAS", direction: "right" }])!;
    expect(outcome.xMovement).toBe("unchanged");
    expect(outcome.curvesAfter.find((c) => c.id === "LRAS")!.vertical).toBeCloseTo(6.6);
  });
});

describe("spendingMultiplier", () => {
  it("computes 1/(1-MPC) and the geometric rounds", () => {
    const r = spendingMultiplier(0.8, 100, 4);
    expect(r.multiplier).toBeCloseTo(5);
    expect(r.total).toBeCloseTo(500);
    expect(r.rounds.map((x) => Math.round(x * 10) / 10)).toEqual([100, 80, 64, 51.2]);
    expect(r.cumulative[3]).toBeCloseTo(295.2);
  });
});

describe("gdpTotal", () => {
  it("adds net exports with their sign", () => {
    expect(gdpTotal({ consumption: 14, investment: 4, government: 3.5, netExports: -0.8 })).toBeCloseTo(20.7);
  });
});

import { cdf, intervalProbability, pdf } from "./stats";

describe("distributions (#35), against published table values", () => {
  it.each([
    ["normal", { mean: 0, sd: 1 }, 1.96, 0.9750021],
    ["normal", { mean: 0, sd: 1 }, -1.645, 0.0499849],
    ["normal", { mean: 100, sd: 15 }, 130, 0.9772499],
    ["t", { df: 10 }, 2.228, 0.97499],
    ["t", { df: 1 }, 1, 0.75], // Cauchy
    ["t", { df: 30 }, -2.042, 0.02501],
    ["chi-square", { df: 3 }, 7.815, 0.95000],
    ["chi-square", { df: 1 }, 3.841, 0.94999],
    ["chi-square", { df: 10 }, 18.307, 0.95000],
  ] as const)("%s %o: P(X <= %d) = %d", (kind, params, x, expected) => {
    expect(cdf(kind, params, x)).toBeCloseTo(expected, 4);
  });

  it("binomial matches exact counts", () => {
    // n=10, p=0.5: P(X <= 2) = (1 + 10 + 45) / 1024
    expect(cdf("binomial", { n: 10, p: 0.5 }, 2)).toBeCloseTo(56 / 1024, 12);
    expect(pdf("binomial", { n: 10, p: 0.5 }, 5)).toBeCloseTo(252 / 1024, 12);
    // inclusive bounds: P(8 <= X) = (45 + 10 + 1) / 1024
    expect(intervalProbability("binomial", { n: 10, p: 0.5 }, 8)).toBeCloseTo(56 / 1024, 12);
  });

  it("integrates to 1 and handles open intervals", () => {
    expect(intervalProbability("normal", { mean: 0, sd: 1 })).toBeCloseTo(1, 12);
    expect(intervalProbability("normal", { mean: 0, sd: 1 }, -1.96, 1.96)).toBeCloseTo(0.95, 3);
    expect(intervalProbability("t", { df: 5 }, 2.015)).toBeCloseTo(0.05, 3);
  });
});
