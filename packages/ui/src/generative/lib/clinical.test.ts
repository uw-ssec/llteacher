import { describe, it, expect } from "vitest";
import {
  diagnosticMetrics,
  evaluateCondition,
  evaluateRule,
  falseAlertPhrase,
  fmtPct,
  fmtRate,
  formatDuration,
  isMonotoneRoc,
  naturalFrequencies,
  npvAt,
  parseClinicalTime,
  ppvAt,
  prevalenceDomain,
  rocCurve,
  tickLabel,
  timeAxis,
  type CdsCondition,
} from "./clinical";

describe("diagnosticMetrics", () => {
  it("computes the eight measures from the 2x2 counts", () => {
    const m = diagnosticMetrics({ tp: 80, fp: 135, fn: 20, tn: 765 });
    expect(m.total).toBe(1000);
    expect(m.sensitivity).toBeCloseTo(0.8);
    expect(m.specificity).toBeCloseTo(0.85);
    expect(m.ppv).toBeCloseTo(80 / 215);
    expect(m.npv).toBeCloseTo(765 / 785);
    expect(m.accuracy).toBeCloseTo(0.845);
    expect(m.prevalence).toBeCloseTo(0.1);
    expect(m.lrPositive).toBeCloseTo(0.8 / 0.15);
    expect(m.lrNegative).toBeCloseTo(0.2 / 0.85);
  });

  it("reports a zero denominator as null, never NaN or Infinity", () => {
    const noCases = diagnosticMetrics({ tp: 0, fp: 10, fn: 0, tn: 90 });
    expect(noCases.sensitivity).toBeNull();
    expect(noCases.ppv).toBe(0); // 0 of 10 positives: zero, not undefined
    expect(noCases.lrPositive).toBeNull();
    expect(noCases.lrNegative).toBeNull();
    expect(noCases.specificity).toBeCloseTo(0.9);

    const perfectSp = diagnosticMetrics({ tp: 9, fp: 0, fn: 1, tn: 90 });
    expect(perfectSp.lrPositive).toBeNull();
    expect(perfectSp.lrNegative).toBeCloseTo(0.1);
    expect(fmtPct(noCases.sensitivity)).toBe("undefined");
  });
});

describe("predictive value across prevalence", () => {
  it("applies Bayes' theorem", () => {
    // 0.8*0.02 / (0.8*0.02 + 0.15*0.98) = 0.016 / 0.163
    expect(ppvAt(0.8, 0.85, 0.02)).toBeCloseTo(0.016 / 0.163, 10);
    // 0.85*0.98 / (0.85*0.98 + 0.2*0.02) = 0.833 / 0.837
    expect(npvAt(0.8, 0.85, 0.02)).toBeCloseTo(0.833 / 0.837, 10);
    expect(ppvAt(0.8, 1, 0.02)).toBe(1);
  });

  it("agrees with the 2x2 table at the table's own prevalence", () => {
    const m = diagnosticMetrics({ tp: 80, fp: 135, fn: 20, tn: 765 });
    expect(ppvAt(0.8, 0.85, 0.1)).toBeCloseTo(m.ppv!, 10);
    expect(npvAt(0.8, 0.85, 0.1)).toBeCloseTo(m.npv!, 10);
  });

  it("counts natural frequencies", () => {
    const nf = naturalFrequencies(0.8, 0.85, 0.02);
    expect(nf.diseased).toBeCloseTo(20);
    expect(nf.truePositive).toBeCloseTo(16);
    expect(nf.falsePositive).toBeCloseTo(147);
  });

  it.each([
    [0.098, "about 9 of every 10 positive alerts are false positives"],
    [0.9, "about 1 of every 10 positive alerts is a false positive"],
    [0.97, "fewer than 1 of every 20 positive alerts is a false positive"],
    [0.04, "at least 19 of every 20 positive alerts are false positives"],
  ])("PPV %s -> %s", (ppv, phrase) => {
    expect(falseAlertPhrase(ppv)).toBe(phrase);
  });

  it("picks an x domain that keeps the prevalence in view", () => {
    expect(prevalenceDomain(0.02)).toBe(0.2);
    expect(prevalenceDomain(0.1)).toBe(0.5);
    expect(prevalenceDomain(0.3)).toBe(1);
    expect(fmtRate(0.02)).toBe("2%");
    expect(fmtRate(0.005)).toBe("0.5%");
  });
});

describe("rocCurve", () => {
  const points = [
    { threshold: "≥ 7", sensitivity: 0.3, specificity: 0.97 },
    { threshold: "≥ 2", sensitivity: 0.94, specificity: 0.42 },
    { threshold: "≥ 5", sensitivity: 0.62, specificity: 0.86 },
    { threshold: "≥ 4", sensitivity: 0.75, specificity: 0.77 },
    { threshold: "≥ 3", sensitivity: 0.86, specificity: 0.62 },
    { threshold: "≥ 6", sensitivity: 0.45, specificity: 0.93 },
  ];

  it("sorts by FPR, anchors (0,0) and (1,1), and integrates by trapezoids", () => {
    const r = rocCurve(points);
    expect(r.sorted.map((p) => p.threshold)).toEqual(["≥ 7", "≥ 6", "≥ 5", "≥ 4", "≥ 3", "≥ 2"]);
    expect(r.curve[0]).toEqual({ fpr: 0, tpr: 0 });
    expect(r.curve[r.curve.length - 1]).toEqual({ fpr: 1, tpr: 1 });
    // 0.0045 + 0.015 + 0.03745 + 0.06165 + 0.12075 + 0.18 + 0.4074
    expect(r.auc).toBeCloseTo(0.82675, 10);
  });

  it("finds the maximum Youden's J", () => {
    const r = rocCurve(points);
    expect(r.best.threshold).toBe("≥ 4");
    expect(r.best.j).toBeCloseTo(0.52);
  });

  it("does not double an anchor the points already include", () => {
    const r = rocCurve([{ sensitivity: 0, specificity: 1 }, { sensitivity: 1, specificity: 0 }]);
    expect(r.curve).toHaveLength(2);
    expect(r.auc).toBeCloseTo(0.5);
  });

  it("recognises points that cannot be one test's thresholds", () => {
    expect(isMonotoneRoc(points)).toBe(true);
    expect(isMonotoneRoc([{ sensitivity: 0.9, specificity: 0.9 }, { sensitivity: 0.5, specificity: 0.5 }])).toBe(false);
  });
});

describe("timeline time", () => {
  it("parses ISO dates and date-times as written, and refuses impossible ones", () => {
    expect(parseClinicalTime("2026-03-03")).toEqual({ at: Date.UTC(2026, 2, 3), hasTime: false, offset: "" });
    expect(parseClinicalTime("2026-03-03T08:40")!.at).toBe(Date.UTC(2026, 2, 3, 8, 40));
    expect(parseClinicalTime("2026-03-03T08:40:15Z")!.offset).toBe("Z");
    expect(parseClinicalTime("2026-03-03T08:40-08:00")!.at).toBe(Date.UTC(2026, 2, 3, 8, 40));
    for (const bad of ["2026-02-30", "2026-13-01", "2026-03-03T24:00", "03/03/2026", "yesterday", "2026-3-3"]) {
      expect(parseClinicalTime(bad), bad).toBeNull();
    }
  });

  it("chooses day ticks for a three-day stay", () => {
    const a = timeAxis(Date.UTC(2026, 2, 3, 8, 40), Date.UTC(2026, 2, 6, 11, 30));
    expect(a.step).toEqual({ unit: "day", n: 1 });
    expect(a.ticks).toEqual([3, 4, 5, 6, 7].map((d) => Date.UTC(2026, 2, d)));
    expect(tickLabel(a, 0)).toEqual({ main: "Mar 3", sub: "2026" });
    expect(tickLabel(a, 1)).toEqual({ main: "Mar 4", sub: undefined });
  });

  it("chooses clock ticks within a morning, dating the first", () => {
    const a = timeAxis(Date.UTC(2026, 2, 3, 8, 40), Date.UTC(2026, 2, 3, 12, 30));
    expect(a.step).toEqual({ unit: "minute", n: 120 });
    expect(tickLabel(a, 0)).toEqual({ main: "08:00", sub: "Mar 3" });
    expect(tickLabel(a, 1)).toEqual({ main: "10:00", sub: undefined });
  });

  it("never draws clock ticks for date-only events, and widens a single instant", () => {
    const d = Date.UTC(2026, 2, 3);
    expect(timeAxis(d, Date.UTC(2026, 2, 4), { datesOnly: true }).step.unit).toBe("day");
    const one = timeAxis(Date.UTC(2026, 2, 3, 8, 40), Date.UTC(2026, 2, 3, 8, 40));
    expect(one.hi - one.lo).toBeGreaterThanOrEqual(6 * 3600_000);
  });

  it("states a duration in days, hours and minutes", () => {
    expect(formatDuration(Date.UTC(2026, 2, 6, 11, 30) - Date.UTC(2026, 2, 3, 8, 40))).toBe("3 d 2 h 50 min");
    expect(formatDuration(0)).toBe("0 min");
  });
});

describe("CDS rule evaluation", () => {
  const conditions: CdsCondition[] = [
    { label: "Blood cultures ordered", field: "cultures", operator: "=", value: "yes" },
    { label: "SBP ≤ 100", field: "sbp", operator: "<=", value: 100 },
    { label: "Lactate ≥ 2", field: "lactate", operator: ">=", value: 2 },
  ];

  it("evaluates each operator, text case-insensitively", () => {
    expect(evaluateCondition(conditions[0]!, { cultures: " Yes " })).toBe("met");
    expect(evaluateCondition(conditions[1]!, { sbp: 100 })).toBe("met");
    expect(evaluateCondition(conditions[1]!, { sbp: 101 })).toBe("not-met");
    expect(evaluateCondition({ label: "", field: "x", operator: "!=", value: 3 }, { x: 3 })).toBe("not-met");
    expect(evaluateCondition(conditions[2]!, {})).toBe("missing");
    expect(evaluateCondition(conditions[2]!, { lactate: null })).toBe("missing");
  });

  it("'all': fires only when every condition is met; a missing value blocks it", () => {
    expect(evaluateRule("all", conditions, { cultures: "yes", sbp: 96, lactate: 3.1 }).outcome).toBe("fires");
    expect(evaluateRule("all", conditions, { cultures: "yes", sbp: 96, lactate: 1.4 }).outcome).toBe("does-not-fire");
    expect(evaluateRule("all", conditions, { cultures: "yes", sbp: 96 }).outcome).toBe("blocked-by-missing");
    // A failed condition settles it, whatever is missing.
    expect(evaluateRule("all", conditions, { cultures: "yes", sbp: 120 }).outcome).toBe("does-not-fire");
  });

  it("'any': fires on one met condition; with none met, missing data leaves it open", () => {
    expect(evaluateRule("any", conditions, { sbp: 96 }).outcome).toBe("fires");
    expect(evaluateRule("any", conditions, { sbp: 120 }).outcome).toBe("blocked-by-missing");
    expect(evaluateRule("any", conditions, { cultures: "no", sbp: 120, lactate: 1 }).outcome).toBe("does-not-fire");
    const ev = evaluateRule("any", conditions, { sbp: 96, lactate: 1 });
    expect([ev.met, ev.notMet, ev.missing]).toEqual([1, 1, 1]);
  });
});
