import { describe, it, expect } from "vitest";
import {
  AIMS,
  DIKW_LEVELS,
  STM_DIMENSIONS,
  aimsInPlay,
  clause,
  dikwSentence,
  joinList,
  summarizeAims,
  summarizeSociotechnical,
  type AimEffect,
  type AimInputs,
} from "./frameworks";

const aim = (effect: AimEffect) => ({ effect, rationale: "r", measure: "m" });
const four = (p: AimEffect, ph: AimEffect, c: AimEffect, ct: AimEffect): AimInputs => ({
  patientExperience: aim(p),
  populationHealth: aim(ph),
  costOfCare: aim(c),
  careTeamWellBeing: aim(ct),
});

describe("helpers", () => {
  it("joins lists in plain English", () => {
    expect(joinList([])).toBe("");
    expect(joinList(["a"])).toBe("a");
    expect(joinList(["a", "b"])).toBe("a and b");
    expect(joinList(["a", "b", "c"])).toBe("a, b and c");
  });

  it("trims trailing punctuation so text can sit mid-sentence", () => {
    expect(clause("Escalates now. ")).toBe("Escalates now");
    expect(clause("HR 118;")).toBe("HR 118");
    expect(clause("38.6 °C")).toBe("38.6 °C");
  });
});

describe("Quadruple Aim", () => {
  it("owns the aims in a fixed order, equity fifth and optional", () => {
    expect(AIMS.map((a) => a.id)).toEqual(["patientExperience", "populationHealth", "costOfCare", "careTeamWellBeing", "healthEquity"]);
    expect(aimsInPlay(false)).toHaveLength(4);
    expect(aimsInPlay(true)).toHaveLength(5);
    expect(AIMS.map((a) => a.slot)).toEqual([1, 2, 3, 4, 5]);
  });

  it("names a single trade-off", () => {
    const s = summarizeAims(four("improves", "improves", "improves", "worsens"), false);
    expect(s.counts).toEqual({ improves: 3, worsens: 1, mixed: 0, unclear: 0 });
    expect(s.sentence).toBe("Improves 3 of 4 aims; trade-off: care team well-being (worsens).");
  });

  it("names several trade-offs, mixed included", () => {
    const s = summarizeAims(four("improves", "mixed", "worsens", "improves"), false);
    expect(s.tradeOffs.map((d) => d.id)).toEqual(["populationHealth", "costOfCare"]);
    expect(s.sentence).toBe("Improves 2 of 4 aims; trade-offs: population health (mixed) and cost of care (worsens).");
  });

  it("all improve", () => {
    expect(summarizeAims(four("improves", "improves", "improves", "improves"), false).sentence).toBe("Improves all 4 aims.");
  });

  it("no improvement means concerns, not trade-offs", () => {
    const s = summarizeAims(four("worsens", "unclear", "unclear", "mixed"), false);
    expect(s.tradeOffs).toEqual([]);
    expect(s.sentence).toBe(
      "Improves none of the 4 aims; patient experience of care (worsens) and care team well-being (mixed), with no aim improving to offset them. Effect unclear for population health and cost of care: their measures would settle it.",
    );
  });

  it("unclear aims alongside improvements", () => {
    const s = summarizeAims(four("improves", "unclear", "improves", "improves"), false);
    expect(s.sentence).toBe("Improves 3 of 4 aims; no trade-off named. Effect unclear for population health: its measure would settle it.");
  });

  it("counts five aims when equity is included", () => {
    const s = summarizeAims({ ...four("improves", "improves", "improves", "improves"), healthEquity: aim("worsens") }, true);
    expect(s.total).toBe(5);
    expect(s.sentence).toBe("Improves 4 of 5 aims; trade-off: health equity (worsens).");
  });
});

describe("sociotechnical model", () => {
  it("owns the eight dimensions in Sittig & Singh's order", () => {
    expect(STM_DIMENSIONS.map((d) => d.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(STM_DIMENSIONS[0]!.name).toBe("Hardware and software computing infrastructure");
    expect(STM_DIMENSIONS[7]!.name).toBe("System measurement and monitoring");
  });

  it("fills unsupplied dimensions as not assessed, in order", () => {
    const s = summarizeSociotechnical([
      { dimension: "workflow", role: "contributing", finding: "w" },
      { dimension: "interface", role: "contributing", finding: "i" },
      { dimension: "people", role: "protective", finding: "p" },
    ]);
    expect(s.rows.map((r) => r.role)).toEqual([
      "not assessed", "not assessed", "contributing", "protective", "contributing", "not assessed", "not assessed", "not assessed",
    ]);
    expect(s.sentence).toBe(
      "2 of 8 dimensions contribute to the problem: human–computer interface (3) and workflow and communication (5). 1 protective: people (4). 5 not assessed.",
    );
  });

  it("says so when nothing contributes and all were assessed", () => {
    const s = summarizeSociotechnical(STM_DIMENSIONS.map((d) => ({ dimension: d.id, role: "protective" as const, finding: "ok" })));
    expect(s.sentence).toBe(
      "No dimension was found to contribute to the problem. 8 protective: infrastructure (1), clinical content (2), human–computer interface (3), people (4), workflow and communication (5), internal policies and culture (6), external rules and pressures (7) and measurement and monitoring (8). All 8 were assessed.",
    );
  });
});

describe("DIKW", () => {
  it("owns four levels in order", () => {
    expect(DIKW_LEVELS.map((l) => l.name)).toEqual(["Data", "Information", "Knowledge", "Wisdom"]);
  });

  it("builds the takeaway from the inputs only", () => {
    const ex = { data: "SpO2 88%.", information: "i", knowledge: "k", wisdom: "Act now." };
    expect(dikwSentence(ex)).toBe("From data (SpO2 88%) to wisdom (Act now): 4 levels, each built on the one before.");
    expect(dikwSentence(ex, "Applies oxygen.")).toBe(
      "From data (SpO2 88%) to wisdom (Act now): 4 levels, each built on the one before. Resulting action: Applies oxygen.",
    );
  });
});
