// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { CLINICAL_FIXTURES } from "./figure/fixtures.clinical";
import {
  parseCdsRuleInput,
  parseDiagnosticAccuracyInput,
  parsePatientTimelineInput,
  parsePrevalenceEffectInput,
  parseRocCurveInput,
} from "./toolInputs.clinical";
import { DiagnosticAccuracy } from "./renderers/clinical/DiagnosticAccuracy";
import { PrevalenceEffect } from "./renderers/clinical/PrevalenceEffect";
import { RocCurve } from "./renderers/clinical/RocCurve";
import { PatientTimeline } from "./renderers/clinical/PatientTimeline";
import { CdsRule } from "./renderers/clinical/CdsRule";

afterEach(cleanup);

const text = () => screen.getByRole("figure").textContent!;

describe("clinical fixtures parse and render inside a <figure>", () => {
  it.each([
    ["showDiagnosticAccuracy", () => <DiagnosticAccuracy {...parseDiagnosticAccuracyInput(CLINICAL_FIXTURES.showDiagnosticAccuracy)!} />],
    ["showPrevalenceEffect", () => <PrevalenceEffect {...parsePrevalenceEffectInput(CLINICAL_FIXTURES.showPrevalenceEffect)!} />],
    ["showRocCurve", () => <RocCurve {...parseRocCurveInput(CLINICAL_FIXTURES.showRocCurve)!} />],
    ["showPatientTimeline", () => <PatientTimeline {...parsePatientTimelineInput(CLINICAL_FIXTURES.showPatientTimeline)!} />],
    ["showCdsRule", () => <CdsRule {...parseCdsRuleInput(CLINICAL_FIXTURES.showCdsRule)!} />],
  ])("%s", (_name, el) => {
    render(el());
    const fig = screen.getByRole("figure");
    expect(fig.getAttribute("aria-label")).toBeTruthy();
    expect(within(fig).getByText("Show the numbers")).toBeTruthy();
  });

  it("every fixture has a parser that accepts it", () => {
    expect(Object.keys(CLINICAL_FIXTURES).sort()).toEqual(
      ["showCdsRule", "showDiagnosticAccuracy", "showPatientTimeline", "showPrevalenceEffect", "showRocCurve"],
    );
  });
});

describe("computed, not trusted", () => {
  it("diagnostic accuracy: PPV in natural frequencies, and every measure", () => {
    render(<DiagnosticAccuracy {...parseDiagnosticAccuracyInput(CLINICAL_FIXTURES.showDiagnosticAccuracy)!} />);
    const t = text();
    expect(t).toContain("Of 215 positive results, 80 have sepsis: PPV = 80 / 215 = 37.2%. The other 135 are false positives.");
    expect(t).toContain("Of 785 negative results, 765 do not have sepsis (NPV 97.5%).");
    const stats = screen.getByRole("figure").querySelector(".gen-stats")!.textContent!;
    for (const s of ["Sensitivity80.0%", "Specificity85.0%", "PPV37.2%", "NPV97.5%", "Accuracy84.5%", "Prevalence10.0%", "LR+5.33", "LR−0.24"]) {
      expect(stats).toContain(s);
    }
  });

  it("diagnostic accuracy: zero denominators say 'undefined' and why", () => {
    render(<DiagnosticAccuracy tp={9} fp={0} fn={1} tn={90} />);
    const t = text();
    expect(t).toContain("None are false positives.");
    expect(t).toContain("there are no false positives (specificity 100%), so LR+ is undefined");
    expect(t).not.toMatch(/NaN|Infinity/);
  });

  it("diagnostic accuracy: no positive results leaves PPV undefined", () => {
    render(<DiagnosticAccuracy tp={0} fp={0} fn={5} tn={95} />);
    expect(text()).toContain("No result was positive, so PPV is undefined.");
    expect(text()).not.toMatch(/NaN|Infinity/);
  });

  it("prevalence effect: the alert-fatigue sentence at 2% prevalence", () => {
    render(<PrevalenceEffect {...parsePrevalenceEffectInput(CLINICAL_FIXTURES.showPrevalenceEffect)!} />);
    const t = text();
    expect(t).toContain("At 2% prevalence, PPV is 9.8%: about 9 of every 10 positive alerts are false positives.");
    expect(t).toContain("Test 1,000 people: 20 have the condition and about 16 of them test positive; 980 do not, and about 147 of them test positive anyway, so about 16 of 163 positives are real.");
    expect(t).toContain("NPV here is 99.5%");
    expect(t).toContain("2% (this population)");
  });

  it("prevalence effect: a rarer condition uses a bigger cohort", () => {
    render(<PrevalenceEffect sensitivity={0.9} specificity={0.99} prevalence={0.001} />);
    // PPV = 0.0009 / (0.0009 + 0.00999) = 8.3%
    expect(text()).toContain("At 0.1% prevalence, PPV is 8.3%: about 9 of every 10 positive alerts are false positives.");
    expect(text()).toContain("Test 10,000 people: 10 have the condition");
  });

  it("ROC: AUC by trapezoids and the maximum Youden point", () => {
    render(<RocCurve {...parseRocCurveInput(CLINICAL_FIXTURES.showRocCurve)!} />);
    const t = text();
    expect(t).toContain("AUC = 0.83 by the trapezoid rule.");
    expect(t).toContain("Youden's J (sensitivity + specificity − 1) is highest at threshold ≥ 4: sensitivity 75.0%, specificity 77.0%, J = 0.52.");
  });

  it("timeline: span, abnormal count and the first abnormal event", () => {
    render(<PatientTimeline {...parsePatientTimelineInput(CLINICAL_FIXTURES.showPatientTimeline)!} />);
    const fig = screen.getByRole("figure");
    expect(text()).toContain("14 events over 3 d 2 h 50 min, Mar 3 – Mar 6, 2026. 4 flagged abnormal; the first is Triage vitals at Mar 3 08:55.");
    const items = fig.querySelectorAll(".gen-timeline__item");
    expect(items).toHaveLength(14);
    expect(items[0]!.textContent).toContain("ED arrival");
    expect([...fig.querySelectorAll(".gen-timeline__flag")].map((n) => n.textContent)).toEqual(Array(4).fill("! Abnormal"));
    expect(fig.querySelectorAll("circle.gen-timeline__ring")).toHaveLength(4);
    // Lanes in the fixed order, only those present.
    const lanes = [...fig.querySelectorAll("svg text.gen-svg__label")].map((n) => n.textContent);
    expect(lanes).toEqual(["Encounter", "Vital signs", "Lab", "Medication", "Order", "Note"]);
  });

  it("timeline: events given out of order are listed chronologically", () => {
    render(
      <PatientTimeline
        events={[
          { time: "2026-03-04", category: "lab", label: "Second" },
          { time: "2026-03-02", category: "note", label: "First" },
        ]}
      />,
    );
    const items = screen.getByRole("figure").querySelectorAll(".gen-timeline__item");
    expect(items[0]!.textContent).toContain("First");
    expect(text()).toContain("2 events over 2 d, Mar 2 – Mar 4, 2026. None is flagged abnormal.");
  });

  it("CDS rule: a missing lactate keeps an 'all' rule silent, and the card says so", () => {
    render(<CdsRule {...parseCdsRuleInput(CLINICAL_FIXTURES.showCdsRule)!} />);
    const fig = screen.getByRole("figure");
    expect(text()).toContain("The rule does not fire, but only because Lactate ≥ 2 mmol/L is missing: a missing value counts as not met.");
    expect(text()).toContain("Patient: 96 mmHg → 96 ≤ 100");
    expect(text()).toContain("Patient: not recorded");
    expect(text()).toContain("3 met, 0 not met, 1 missing");
    const results = [...fig.querySelectorAll(".gen-cds__result")].map((n) => n.textContent);
    expect(results).toEqual(["Met", "Met", "Met", "Missing"]);
    expect([...fig.querySelectorAll(".gen-cds__mark")].map((n) => n.textContent)).toEqual(["✓", "✓", "✓", "?"]);
  });

  it("CDS rule: fires once the lactate is resulted", () => {
    const input = CLINICAL_FIXTURES.showCdsRule as { patient: Record<string, unknown> };
    render(<CdsRule {...parseCdsRuleInput({ ...input, patient: { ...input.patient, lactate: 3.4 } })!} />);
    expect(text()).toContain("The rule fires: all 4 conditions are met.");
    expect(text()).toContain("Recommended: Notify the covering clinician");
  });

  it("CDS rule: 'any' logic with one condition met", () => {
    render(
      <CdsRule
        name="Hypoglycaemia"
        logic="any"
        conditions={[
          { label: "Glucose < 70", field: "glucose", operator: "<", value: 70, unit: "mg/dL" },
          { label: "Insulin given", field: "insulin", operator: "=", value: "yes" },
        ]}
        patient={{ glucose: 62 }}
      />,
    );
    expect(text()).toContain("The rule fires: 1 of 2 conditions is met, and any one is enough.");
  });
});

describe("parsers refuse meaningless input", () => {
  const dx = CLINICAL_FIXTURES.showDiagnosticAccuracy as Record<string, unknown>;
  const roc = CLINICAL_FIXTURES.showRocCurve as { points: unknown[] };
  const tl = CLINICAL_FIXTURES.showPatientTimeline as { events: Array<Record<string, unknown>> };
  const cds = CLINICAL_FIXTURES.showCdsRule as { conditions: Array<Record<string, unknown>>; patient: Record<string, unknown> };

  it.each([
    ["a fractional count", () => parseDiagnosticAccuracyInput({ ...dx, tp: 80.5 })],
    ["a negative count", () => parseDiagnosticAccuracyInput({ ...dx, fn: -1 })],
    ["a count sent as text", () => parseDiagnosticAccuracyInput({ ...dx, tn: "765" })],
    ["an empty table", () => parseDiagnosticAccuracyInput({ tp: 0, fp: 0, fn: 0, tn: 0 })],
    ["a missing count", () => parseDiagnosticAccuracyInput({ tp: 1, fp: 2, fn: 3 })],
  ])("diagnostic accuracy: %s", (_l, parse) => expect(parse()).toBeNull());

  it.each([
    ["sensitivity as a percentage", () => parsePrevalenceEffectInput({ sensitivity: 80, specificity: 0.85, prevalence: 0.02 })],
    ["a specificity of 0", () => parsePrevalenceEffectInput({ sensitivity: 0.8, specificity: 0, prevalence: 0.02 })],
    ["a prevalence of 0", () => parsePrevalenceEffectInput({ sensitivity: 0.8, specificity: 0.85, prevalence: 0 })],
    ["a prevalence of 1", () => parsePrevalenceEffectInput({ sensitivity: 0.8, specificity: 0.85, prevalence: 1 })],
    ["a prevalence as a percentage", () => parsePrevalenceEffectInput({ sensitivity: 0.8, specificity: 0.85, prevalence: 2 })],
  ])("prevalence effect: %s", (_l, parse) => expect(parse()).toBeNull());

  it.each([
    ["a single point", () => parseRocCurveInput({ points: roc.points.slice(0, 1) })],
    ["more than 30 points", () => parseRocCurveInput({ points: Array.from({ length: 31 }, (_, i) => ({ sensitivity: i / 30, specificity: 1 - i / 30 })) })],
    ["a sensitivity above 1", () => parseRocCurveInput({ points: [{ sensitivity: 1.2, specificity: 0.5 }, { sensitivity: 0.5, specificity: 0.8 }] })],
    ["points that are not one test's thresholds", () => parseRocCurveInput({ points: [{ sensitivity: 0.9, specificity: 0.9 }, { sensitivity: 0.5, specificity: 0.5 }] })],
    ["the same point twice", () => parseRocCurveInput({ points: [{ sensitivity: 0.7, specificity: 0.7 }, { sensitivity: 0.7, specificity: 0.7 }] })],
    ["a threshold that is an object", () => parseRocCurveInput({ points: [{ sensitivity: 0.5, specificity: 0.8, threshold: {} }, { sensitivity: 0.8, specificity: 0.5 }] })],
  ])("ROC: %s", (_l, parse) => expect(parse()).toBeNull());

  it.each([
    ["no events", () => parsePatientTimelineInput({ events: [] })],
    ["an impossible date", () => parsePatientTimelineInput({ events: [{ ...tl.events[0], time: "2026-02-30T08:00" }] })],
    ["a date that is not ISO", () => parsePatientTimelineInput({ events: [{ ...tl.events[0], time: "March 3, 2026" }] })],
    ["an unknown category", () => parsePatientTimelineInput({ events: [{ ...tl.events[0], category: "imaging" }] })],
    ["an empty label", () => parsePatientTimelineInput({ events: [{ ...tl.events[0], label: "  " }] })],
    ["abnormal as text", () => parsePatientTimelineInput({ events: [{ ...tl.events[0], abnormal: "yes" }] })],
    ["mixed time zones", () => parsePatientTimelineInput({ events: [{ ...tl.events[0], time: "2026-03-03T08:40Z" }, { ...tl.events[1], time: "2026-03-03T08:55-08:00" }] })],
    ["more than 40 events", () => parsePatientTimelineInput({ events: Array.from({ length: 41 }, () => tl.events[0]) })],
  ])("timeline: %s", (_l, parse) => expect(parse()).toBeNull());

  it.each([
    ["an unknown logic", () => parseCdsRuleInput({ ...cds, logic: "majority" })],
    ["an unknown operator", () => parseCdsRuleInput({ ...cds, conditions: [{ ...cds.conditions[1], operator: "=>" }] })],
    ["text compared with >", () => parseCdsRuleInput({ ...cds, conditions: [{ ...cds.conditions[0], operator: ">" }] })],
    ["a number compared with recorded text", () => parseCdsRuleInput({ ...cds, patient: { ...cds.patient, systolicBP: "96" } })],
    ["no conditions", () => parseCdsRuleInput({ ...cds, conditions: [] })],
    ["more than 8 conditions", () => parseCdsRuleInput({ ...cds, conditions: Array.from({ length: 9 }, () => cds.conditions[1]) })],
    ["a patient that is not an object", () => parseCdsRuleInput({ ...cds, patient: [96] })],
    ["a patient value that is an object", () => parseCdsRuleInput({ ...cds, patient: { ...cds.patient, lactate: { value: 2 } } })],
    ["no rule name", () => parseCdsRuleInput({ ...cds, name: "" })],
  ])("CDS rule: %s", (_l, parse) => expect(parse()).toBeNull());
});
