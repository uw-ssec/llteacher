import { describe, it, expect } from "vitest";
import {
  MILESTONES,
  STANDARDS,
  changeSentence,
  fmtDelta,
  groupByStandard,
  joinAnd,
  stateSentence,
  standardsSentence,
  timelineSentence,
  timelineView,
  workflowStats,
  type WorkflowStep,
} from "./systems";

const step = (role: string, kind: WorkflowStep["kind"], minutes?: number): WorkflowStep =>
  minutes === undefined ? { role, action: "x", kind } : { role, action: "x", kind, minutes };

describe("workflowStats", () => {
  it("counts handoffs as role changes between consecutive steps", () => {
    const s = workflowStats([step("A", "task", 1), step("A", "documentation", 2), step("B", "wait", 3), step("A", "decision", 4)]);
    expect(s).toMatchObject({ steps: 4, handoffs: 2, documentation: 1, waits: 1, decisions: 1, minutes: 10 });
    expect(s.handoffFrom).toEqual([null, null, "A", "B"]);
  });

  it("gives no total time unless every step has minutes", () => {
    expect(workflowStats([step("A", "task", 1), step("B", "task")]).minutes).toBeNull();
    expect(workflowStats([step("A", "task", 0.1), step("A", "task", 0.2)]).minutes).toBe(0.3);
  });

  it("a single step has no handoff", () => {
    expect(workflowStats([step("A", "task")]).handoffs).toBe(0);
  });
});

describe("workflow sentences", () => {
  const cur = workflowStats([step("A", "documentation", 5), step("B", "wait", 10), step("A", "task", 3)]);
  const fut = workflowStats([step("A", "task", 2), step("A", "documentation", 1)]);
  it("states one state's counts, singular where it should be", () => {
    expect(stateSentence("Current state", cur)).toBe("Current state: 3 steps, 2 handoffs, 1 documentation step, 1 wait, 18 min.");
  });
  it("states the change without a verdict", () => {
    expect(changeSentence(cur, fut)).toBe("Future state: 3 → 2 steps, 2 → 0 handoffs, 1 → 1 documentation step, 1 → 0 waits, 18 → 3 min.");
  });
  it("does not compare time when a step has no minutes", () => {
    const untimed = workflowStats([step("A", "task")]);
    expect(changeSentence(cur, untimed)).toContain("time not compared (not every step gives its minutes)");
    expect(stateSentence("Future state", untimed)).toBe("Future state: 1 step, 0 handoffs, 0 documentation steps, 0 waits, time not given.");
  });
  it("formats signed differences", () => {
    expect(fmtDelta(9, 7)).toBe("−2");
    expect(fmtDelta(4, 5)).toBe("+1");
    expect(fmtDelta(3, 3)).toBe("0");
    expect(fmtDelta(null, 3)).toBe("not given");
  });
});

describe("standards", () => {
  it("has unique ids and three categories", () => {
    expect(new Set(STANDARDS.map((s) => s.id)).size).toBe(STANDARDS.length);
    expect(STANDARDS).toHaveLength(18);
  });

  it("groups by category in fixed order, standards in catalog order", () => {
    const g = groupByStandard([
      { element: "a", standard: "nanda-i" },
      { element: "b", standard: "rxnorm" },
      { element: "c", standard: "loinc" },
      { element: "d", standard: "loinc" },
    ]);
    expect(g.map((c) => c.category)).toEqual(["terminology", "nursing"]);
    expect(g[0]!.groups.map((x) => x.standard.id)).toEqual(["loinc", "rxnorm"]);
    expect(g[0]!.groups[0]!.elements.map((e) => e.index)).toEqual([2, 3]);
  });

  it("states counts by standard, largest first", () => {
    expect(
      standardsSentence(
        [{ element: "a", standard: "rxnorm" }, { element: "b", standard: "loinc" }, { element: "c", standard: "rxnorm" }],
        { standard: "hl7-v2", resource: "ORU^R01" },
      ),
    ).toBe("3 elements across 2 standards: 2 in RxNorm and 1 in LOINC; exchanged in HL7 v2 ORU^R01 messages.");
    expect(standardsSentence([{ element: "a", standard: "noc" }])).toBe("1 element across 1 standard: 1 in NOC.");
  });

  it("joins lists in plain English", () => {
    expect(joinAnd(["a"])).toBe("a");
    expect(joinAnd(["a", "b", "c"])).toBe("a, b and c");
  });
});

describe("health IT timeline", () => {
  it("has 25 entries in year order with unique ids", () => {
    expect(MILESTONES).toHaveLength(25);
    expect(new Set(MILESTONES.map((m) => m.id)).size).toBe(25);
    expect(MILESTONES.every((m, i) => i === 0 || m.year >= MILESTONES[i - 1]!.year)).toBe(true);
  });

  it("assigns the categories the course uses", () => {
    const cat = Object.fromEntries(MILESTONES.map((m) => [m.id, m.category]));
    expect(cat["help-system"]).toBe("system");
    expect(cat["ana-nursing-informatics"]).toBe("nursing");
    expect(cat["quadruple-aim"]).toBe("report");
    expect(cat["fda-bar-code-rule"]).toBe("standard");
    expect(cat["hipaa"]).toBe("policy");
    expect(MILESTONES.filter((m) => m.category === "standard")).toHaveLength(5);
    expect(MILESTONES.filter((m) => m.category === "report")).toHaveLength(5);
  });

  it("defaults the range to what is highlighted and shows context in between", () => {
    const v = timelineView(["to-err-is-human", "onc-created"], []);
    expect([v.from, v.to]).toEqual([1999, 2004]);
    expect(v.shown.map((m) => m.id)).toEqual(["to-err-is-human", "quality-chasm", "onc-created", "fda-bar-code-rule"]);
    expect(v.highlightedCount).toBe(2);
    expect(v.decades).toEqual([1990, 2000]);
    expect(timelineSentence(v, 0)).toBe("4 reference milestones from 1999 to 2004 (5 years): 1 policy, 2 report and 1 standard. 2 highlighted.");
  });

  it("'all' highlights everything and says nothing about highlighting", () => {
    const v = timelineView("all", []);
    expect(v.shown).toHaveLength(25);
    expect(v.decades).toEqual([1960, 1970, 1980, 1990, 2000, 2010, 2020]);
    expect(timelineSentence(v, 0)).toBe("25 reference milestones from 1967 to 2023 (56 years): 11 policy, 5 report, 5 standard, 2 system and 2 nursing.");
  });

  it("a local event can widen the default range", () => {
    const v = timelineView(["hipaa"], [{ year: 2001, label: "x" }]);
    expect([v.from, v.to]).toEqual([1996, 2001]);
    expect(timelineSentence(v, 1)).toContain("Plus 1 event added by your tutor.");
  });

  it("a single year", () => {
    const v = timelineView(["fhir-r4"], []);
    expect(timelineSentence(v, 0)).toBe("2 reference milestones in 2018: 1 policy and 1 standard. 1 highlighted.");
  });
});
