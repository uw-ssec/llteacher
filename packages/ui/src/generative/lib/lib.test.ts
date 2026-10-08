import { describe, it, expect } from "vitest";
import { leaves, normalizeDna, parseNewick, residueClass, scoreAlignment, translate } from "./bio";
import { MACRO_MODELS, applyShifts, gdpTotal, intersect, spendingMultiplier } from "./econ";

describe("translate (standard genetic code)", () => {
  it("translates codons and marks start and stop", () => {
    const codons = translate("ATGGCCATTGTAATGGGCCGCTGAAAG");
    expect(codons.map((c) => c.aa).join("")).toBe("MAIVMGR*K");
    expect(codons[0]).toMatchObject({ dna: "ATG", mrna: "AUG", three: "Met", isStart: true, start: 1 });
    expect(codons[7]).toMatchObject({ dna: "TGA", aa: "*", three: "Stop", isStop: true, start: 22 });
  });

  it("honours the reading frame and drops an incomplete last codon", () => {
    expect(translate("AATGTTTA", 1).map((c) => c.dna)).toEqual(["ATG", "TTT"]);
  });

  it("covers all 64 codons, including every stop", () => {
    const stops = ["TAA", "TAG", "TGA"].map((c) => translate(c)[0]!.aa);
    expect(stops).toEqual(["*", "*", "*"]);
    expect(translate("TGG")[0]!.aa).toBe("W");
    expect(translate("GGG")[0]!.aa).toBe("G");
  });
});

describe("normalizeDna", () => {
  it("strips numbering and whitespace, reads U as T, reports invalid symbols", () => {
    expect(normalizeDna("1 atg gcu\n61 tta")).toEqual({ dna: "ATGGCTTTA", invalid: [] });
    expect(normalizeDna("ATGXN").invalid).toEqual(["X", "N"]);
  });
});

describe("residueClass", () => {
  it("groups by side chain", () => {
    expect([residueClass("L"), residueClass("S"), residueClass("K"), residueClass("D"), residueClass("G")]).toEqual([
      "nonpolar", "polar", "positive", "negative", "special",
    ]);
    expect(residueClass("*")).toBeNull();
  });
});

describe("scoreAlignment", () => {
  it("counts matches, mismatches and gaps and scores them linearly", () => {
    const s = scoreAlignment("GATTACA", "GA-TACC", { match: 1, mismatch: -1, gap: -2 });
    expect(s).toMatchObject({ length: 7, matches: 5, mismatches: 1, gaps: 1, score: 2, identity: 71.4 });
    expect(s.columns).toEqual(["match", "match", "gap", "match", "match", "match", "mismatch"]);
  });
});

describe("parseNewick", () => {
  it("parses nested clades, branch lengths and quoted names", () => {
    const tree = parseNewick("((Human:0.1,Chimp:0.12):0.3,'Mus musculus':0.6);")!;
    expect(tree.children).toHaveLength(2);
    expect(leaves(tree).map((l) => l.name)).toEqual(["Human", "Chimp", "Mus musculus"]);
    expect(tree.children[0]!.length).toBe(0.3);
  });

  it("reads underscores as spaces and tolerates trees without lengths", () => {
    expect(leaves(parseNewick("(Homo_sapiens,Pan);")!).map((l) => l.name)).toEqual(["Homo sapiens", "Pan"]);
  });

  it("rejects malformed trees instead of drawing a wrong one", () => {
    expect(parseNewick("((A,B);")).toBeNull();
    expect(parseNewick("(A,B)C)extra;")).toBeNull();
    expect(parseNewick("(A:-1,B);")).toBeNull();
  });
});

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
