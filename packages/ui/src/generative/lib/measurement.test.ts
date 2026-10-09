import { describe, it, expect } from "vitest";
import {
  ADOPTER_CATEGORIES,
  adoptionZ,
  analyseRunChart,
  closestAdjective,
  findShifts,
  findTrends,
  firstReached,
  fmtAdoptedPct,
  fmtNum,
  median,
  nextCategoryIndex,
  normalCdf,
  ratePct,
  sideOf,
  signalFavourable,
  susContribution,
  susScore,
  susSummary,
} from "./measurement";

describe("median", () => {
  it("odd and even counts, unsorted input", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([88, 90, 87.5, 89.5, 91, 88.5, 90.5, 89])).toBe(89.25);
  });
});

describe("run chart rules", () => {
  it("a shift needs 6 points on one side", () => {
    expect(findShifts([2, 2, 2, 2, 2, 0, 0], 1)).toEqual([]);
    expect(findShifts([2, 2, 2, 2, 2, 2, 0], 1)).toEqual([{ kind: "shift", direction: "up", points: [0, 1, 2, 3, 4, 5] }]);
    expect(findShifts([0, 5, 0, 0, 0, 0, 0, 0], 1)).toEqual([{ kind: "shift", direction: "down", points: [2, 3, 4, 5, 6, 7] }]);
  });

  it("a point on the median neither counts nor breaks a shift", () => {
    // 5 above, one on, 1 above: 6 counted points.
    expect(findShifts([2, 2, 2, 1, 2, 2, 2], 1)[0]!.points).toEqual([0, 1, 2, 4, 5, 6]);
    // 3 above, on, 2 above: only 5 counted.
    expect(findShifts([2, 2, 2, 1, 2, 2], 1)).toEqual([]);
    expect(sideOf(1, 1)).toBe("on");
  });

  it("a trend needs 5 points all rising or all falling", () => {
    expect(findTrends([1, 2, 3, 4])).toEqual([]);
    expect(findTrends([1, 2, 3, 4, 5])).toEqual([{ kind: "trend", direction: "up", points: [0, 1, 2, 3, 4] }]);
    expect(findTrends([1, 2, 3, 4, 3, 4, 5, 6])).toEqual([]);
  });

  it("a repeated value neither counts nor breaks a trend", () => {
    expect(findTrends([1, 2, 2, 3, 4])).toEqual([]);
    expect(findTrends([1, 2, 2, 3, 4, 5])).toEqual([{ kind: "trend", direction: "up", points: [0, 1, 3, 4, 5] }]);
  });

  it("a fall then a rise are two trends sharing the turning point", () => {
    expect(findTrends([9, 8, 7, 6, 5, 6, 7, 8, 9])).toEqual([
      { kind: "trend", direction: "down", points: [0, 1, 2, 3, 4] },
      { kind: "trend", direction: "up", points: [4, 5, 6, 7, 8] },
    ]);
  });

  it("BCMA fixture: baseline median 89.25%, one 12-point shift from week 9", () => {
    const rates = [352, 360, 350, 358, 364, 354, 362, 356, 366, 360, 370, 372, 368, 376, 374, 380, 378, 382, 376, 384].map((x) => ratePct(x, 400));
    const a = analyseRunChart(rates, 8);
    expect(a.median).toBe(89.25);
    expect(a.signals).toHaveLength(1);
    expect(a.signals[0]).toMatchObject({ kind: "shift", direction: "up" });
    expect(a.signals[0]!.points).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(signalFavourable(a.signals[0]!, "up")).toBe(true);
    expect(signalFavourable(a.signals[0]!, "down")).toBe(false);
    expect(signalFavourable(a.signals[0]!)).toBeNull();
  });

  it("formats values", () => {
    expect(fmtNum(89.25)).toBe("89.25");
    expect(fmtNum(1234.5)).toBe("1,234.5");
    expect(fmtNum(100 / 3)).toBe("33.33");
  });
});

describe("System Usability Scale", () => {
  it("odd items contribute response − 1, even items 5 − response", () => {
    expect(susContribution(0, 4)).toBe(3);
    expect(susContribution(1, 4)).toBe(1);
  });

  it("scores 0–100", () => {
    expect(susScore([3, 3, 3, 3, 3, 3, 3, 3, 3, 3])).toBe(50);
    expect(susScore([5, 1, 5, 1, 5, 1, 5, 1, 5, 1])).toBe(100);
    expect(susScore([1, 5, 1, 5, 1, 5, 1, 5, 1, 5])).toBe(0);
    // 4+3+3+4+3+3+4+2+3+3 = 32, × 2.5
    expect(susScore([5, 2, 4, 1, 4, 2, 5, 3, 4, 2])).toBe(80);
  });

  it("summary: mean, range and the lowest item", () => {
    const s = susSummary([
      [4, 2, 4, 2, 4, 2, 4, 4, 4, 2], // 15 + 13 = 28 -> 70
      [3, 3, 3, 3, 3, 3, 3, 3, 3, 3], // 50
    ]);
    expect(s.scores).toEqual([70, 50]);
    expect(s.mean).toBe(60);
    expect([s.min, s.max, s.n]).toEqual([50, 70, 2]);
    // Item 8: responses 4 and 3 -> contributions 1 and 2, mean 1.5.
    expect(s.itemMeanContribution[7]).toBe(1.5);
    expect(s.itemMeanResponse[7]).toBe(3.5);
    expect(s.lowestItems).toEqual([8]);
  });

  it("ties for lowest are all kept", () => {
    expect(susSummary([[3, 3, 3, 3, 3, 3, 3, 3, 3, 3]]).lowestItems).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("nearest Bangor adjective", () => {
    expect(closestAdjective(62.3).adjective).toBe("Good"); // 9.1 from 71.4, 11.4 from 50.9
    expect(closestAdjective(55).adjective).toBe("OK");
    expect(closestAdjective(61.15).adjective).toBe("OK"); // exact midpoint goes low
    expect(closestAdjective(100).adjective).toBe("Best imaginable");
    expect(closestAdjective(0).adjective).toBe("Worst imaginable");
  });
});

describe("diffusion of innovations", () => {
  it("shares add to 100 and cumulate to 2.5, 16, 50, 84, 100", () => {
    expect(ADOPTER_CATEGORIES.reduce((s, c) => s + c.share, 0)).toBe(100);
    expect(ADOPTER_CATEGORIES.map((c) => c.to)).toEqual([2.5, 16, 50, 84, 100]);
  });

  it("the category the next adopters fall in", () => {
    expect(nextCategoryIndex(0)).toBe(0);
    expect(nextCategoryIndex(2.5)).toBe(1);
    expect(nextCategoryIndex(15.99)).toBe(1);
    expect(nextCategoryIndex(16)).toBe(2);
    expect(nextCategoryIndex(42)).toBe(2);
    expect(nextCategoryIndex(50)).toBe(3);
    expect(nextCategoryIndex(84)).toBe(4);
    expect(nextCategoryIndex(100)).toBeNull();
  });

  it("percent adopted rounds down so it never reads past an unreached mark", () => {
    expect(fmtAdoptedPct(15.97)).toBe("15.9%");
    expect(fmtAdoptedPct(42)).toBe("42%");
    expect(fmtAdoptedPct((26 / 150) * 100)).toBe("17.3%");
  });

  it("position on the bell curve", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(-1)).toBeCloseTo(0.158655, 5);
    expect(adoptionZ(16)).toBeCloseTo(-1, 4);
    expect(adoptionZ(50)).toBeCloseTo(0, 4);
    expect(adoptionZ(2.5)).toBeCloseTo(-2, 4);
    // Halfway through the early majority: Φ(z) = 0.158655 + 0.5 × 0.341345 = 0.329328 -> z ≈ −0.4413.
    expect(adoptionZ(33)).toBeCloseTo(-0.4413, 3);
    expect(adoptionZ(0)).toBe(-Infinity);
    expect(adoptionZ(100)).toBe(Infinity);
  });

  it("when a mark was first reached", () => {
    const pcts = [2, 5, 14, 26, 41].map((x) => (x / 150) * 100);
    expect(firstReached(pcts, 16)).toBe(3);
    expect(firstReached(pcts, 50)).toBeNull();
    expect(firstReached([20, 30], 16)).toBe(0);
  });
});
