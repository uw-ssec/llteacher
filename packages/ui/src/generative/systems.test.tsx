// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { SYSTEMS_FIXTURES } from "./figure/fixtures.systems";
import { parseHealthItTimelineInput, parseStandardsMapInput, parseWorkflowComparisonInput } from "./toolInputs.systems";
import { WorkflowComparison } from "./renderers/informatics/WorkflowComparison";
import { StandardsMap } from "./renderers/informatics/StandardsMap";
import { HealthItTimeline } from "./renderers/informatics/HealthItTimeline";

afterEach(cleanup);

const text = () => screen.getByRole("figure").textContent!;

describe("systems fixtures parse and render inside a <figure>", () => {
  it.each([
    ["showWorkflowComparison", () => <WorkflowComparison {...parseWorkflowComparisonInput(SYSTEMS_FIXTURES.showWorkflowComparison)!} />],
    ["showStandardsMap", () => <StandardsMap {...parseStandardsMapInput(SYSTEMS_FIXTURES.showStandardsMap)!} />],
    ["showHealthItTimeline", () => <HealthItTimeline {...parseHealthItTimelineInput(SYSTEMS_FIXTURES.showHealthItTimeline)!} />],
  ])("%s", (_name, el) => {
    render(el());
    const fig = screen.getByRole("figure");
    expect(fig.getAttribute("aria-label")).toBeTruthy();
    expect(within(fig).getByText("Show the numbers")).toBeTruthy();
  });

  it("every fixture has a parser that accepts it", () => {
    expect(Object.keys(SYSTEMS_FIXTURES).sort()).toEqual(["showHealthItTimeline", "showStandardsMap", "showWorkflowComparison"]);
    expect(parseWorkflowComparisonInput(SYSTEMS_FIXTURES.showWorkflowComparison)).not.toBeNull();
    expect(parseStandardsMapInput(SYSTEMS_FIXTURES.showStandardsMap)).not.toBeNull();
    expect(parseHealthItTimelineInput(SYSTEMS_FIXTURES.showHealthItTimeline)).not.toBeNull();
  });
});

describe("computed, not trusted", () => {
  it("workflow: the change from paper MAR to BCMA, counted", () => {
    render(<WorkflowComparison {...parseWorkflowComparisonInput(SYSTEMS_FIXTURES.showWorkflowComparison)!} />);
    const fig = screen.getByRole("figure");
    expect(text()).toContain("Future state: 9 → 7 steps, 4 → 5 handoffs, 2 → 1 documentation steps, 1 → 0 waits, 25 → 7 min.");
    expect(fig.getAttribute("aria-label")).toContain("Current state: 9 steps, 4 handoffs, 2 documentation steps, 1 wait, 25 min.");
    expect(fig.querySelector(".gen-figure__takeaway")!.textContent).not.toMatch(/safe|better|improve/i);
    expect(text()).toContain("does not by itself make a process safer");
    const lists = fig.querySelectorAll("ol.gen-sy-steps");
    expect(lists).toHaveLength(2);
    expect(lists[0]!.querySelectorAll("li")).toHaveLength(9);
    expect(lists[1]!.querySelectorAll("li")).toHaveLength(7);
    expect([...lists[0]!.querySelectorAll(".gen-sy-step__handoff")].map((n) => n.textContent)).toEqual([
      "Handoff from Nurse",
      "Handoff from Pharmacist",
      "Handoff from Nurse",
      "Handoff from Patient",
    ]);
    // Every step names its kind in words, not colour alone.
    expect(lists[0]!.querySelectorAll(".gen-sy-step__kind")[4]!.textContent).toContain("Wait");
    // Table: change column.
    const rows = [...fig.querySelectorAll(".gen-figure__table tbody tr")].map((r) => r.textContent);
    expect(rows[0]).toBe("Steps97−2");
    expect(rows[1]).toBe("Handoffs45+1");
  });

  it("workflow: one state only, without times", () => {
    render(
      <WorkflowComparison
        process="Shift handoff"
        roles={["Day nurse", "Night nurse"]}
        current={[
          { role: "Day nurse", action: "Prints the handoff report", kind: "documentation" },
          { role: "Day nurse", action: "Gives verbal SBAR report", kind: "communication", minutes: 5 },
          { role: "Night nurse", action: "Asks questions", kind: "communication", minutes: 3 },
        ]}
      />,
    );
    expect(text()).toContain("Current state: 3 steps, 1 handoff, 1 documentation step, 0 waits, time not given.");
    expect(screen.getByRole("figure").querySelectorAll("ol.gen-sy-steps")).toHaveLength(1);
    expect(text()).not.toContain("Future state");
  });

  it("standards: grouped by category, stewards from the catalog, codes labelled as given", () => {
    render(<StandardsMap {...parseStandardsMapInput(SYSTEMS_FIXTURES.showStandardsMap)!} />);
    const fig = screen.getByRole("figure");
    expect(text()).toContain("7 elements across 4 standards: 3 in LOINC, 2 in UCUM, 1 in SNOMED CT and 1 in NANDA-I; exchanged as FHIR Observation resources.");
    expect([...fig.querySelectorAll(".gen-sy-cat__head")].map((n) => n.textContent)).toEqual([
      "Terminologies and code sets",
      "Nursing terminologies",
      "Exchanged between systems",
    ]);
    expect([...fig.querySelectorAll(".gen-sy-std .gen-sy-std__name")].map((n) => n.textContent)).toEqual(["LOINC", "SNOMED CT", "UCUM", "NANDA-I"]);
    expect(text()).toContain("Regenstrief Institute.");
    expect(text()).toContain("NANDA International.");
    expect(fig.querySelectorAll(".gen-sy-el__caveat")).toHaveLength(7);
    expect(fig.querySelector(".gen-sy-el__caveat")!.textContent).toBe("code as given — verify in the terminology browser");
    expect(fig.querySelector("code.gen-sy-el__value")!.textContent).toBe("72514-3");
  });

  it("standards: no exchange and no codes", () => {
    render(<StandardsMap scenario="Discharge teaching" elements={[{ element: "Medication list", standard: "rxnorm" }, { element: "Knowledge: medication", standard: "noc" }]} />);
    expect(text()).toContain("2 elements across 2 standards: 1 in RxNorm and 1 in NOC.");
    expect(text()).toContain("no code given");
    expect(text()).not.toContain("verify in the terminology browser");
  });

  it("timeline: the reference entries in range, highlighted ones marked, the local event labelled", () => {
    render(<HealthItTimeline {...parseHealthItTimelineInput(SYSTEMS_FIXTURES.showHealthItTimeline)!} />);
    const fig = screen.getByRole("figure");
    expect(text()).toContain("9 reference milestones from 1999 to 2011 (12 years): 4 policy, 3 report, 1 standard and 1 nursing. 5 highlighted. Plus 1 event added by your tutor.");
    expect([...fig.querySelectorAll(".gen-sy-tl__decade-head")].map((n) => n.textContent)).toEqual(["1990s", "2000s", "2010s"]);
    expect(fig.querySelectorAll(".gen-sy-tl__item")).toHaveLength(10);
    expect(fig.querySelectorAll(".gen-sy-tl__item--hi")).toHaveLength(5);
    const local = fig.querySelector(".gen-sy-tl__item--local")!;
    expect(local.textContent).toContain("Added by your tutor, not from the reference list");
    // The local 2008 event sits after the 2008 reference entry.
    const years = [...fig.querySelectorAll(".gen-sy-tl__year")].map((n) => n.textContent);
    expect(years).toEqual(["1999", "2001", "2004", "2004", "2006", "2008", "2008", "2009", "2010", "2011"]);
    expect(fig.querySelectorAll(".gen-sy-tl__item")[6]!.className).toContain("--local");
  });

  it("timeline: 'all' shows every reference entry and empty decades say so", () => {
    render(<HealthItTimeline highlight="all" />);
    expect(text()).toContain("25 reference milestones from 1967 to 2023 (56 years)");
    expect(text()).toContain("No milestones from the reference list in the 1970s.");
    expect(text()).not.toContain("highlighted.");
  });
});

describe("parsers refuse meaningless input", () => {
  const wf = SYSTEMS_FIXTURES.showWorkflowComparison as { roles: string[]; current: Array<Record<string, unknown>>; future: unknown[] };
  const sm = SYSTEMS_FIXTURES.showStandardsMap as { elements: Array<Record<string, unknown>> };
  const tl = SYSTEMS_FIXTURES.showHealthItTimeline as Record<string, unknown>;

  it.each([
    ["a step whose role is not a lane", () => parseWorkflowComparisonInput({ ...wf, current: [{ ...wf.current[0], role: "Physician" }] })],
    ["an unknown step kind", () => parseWorkflowComparisonInput({ ...wf, current: [{ ...wf.current[0], kind: "handoff" }] })],
    ["negative minutes", () => parseWorkflowComparisonInput({ ...wf, current: [{ ...wf.current[0], minutes: -2 }] })],
    ["minutes as text", () => parseWorkflowComparisonInput({ ...wf, current: [{ ...wf.current[0], minutes: "2" }] })],
    ["one role", () => parseWorkflowComparisonInput({ ...wf, roles: ["Nurse"], current: [wf.current[0]], future: undefined, futureLabel: undefined })],
    ["seven roles", () => parseWorkflowComparisonInput({ ...wf, roles: ["Nurse", "Pharmacist", "Patient", "EHR", "A", "B", "C"] })],
    ["duplicate roles", () => parseWorkflowComparisonInput({ ...wf, roles: ["Nurse", "nurse", "Patient", "EHR", "Pharmacist"] })],
    ["no current steps", () => parseWorkflowComparisonInput({ ...wf, current: [] })],
    ["more than 20 steps", () => parseWorkflowComparisonInput({ ...wf, future: Array.from({ length: 21 }, () => wf.current[0]) })],
    ["a future label with no future state", () => parseWorkflowComparisonInput({ ...wf, future: undefined })],
    ["an empty process name", () => parseWorkflowComparisonInput({ ...wf, process: " " })],
  ])("workflow: %s", (_l, parse) => expect(parse()).toBeNull());

  it.each([
    ["an unknown standard", () => parseStandardsMapInput({ ...sm, elements: [{ ...sm.elements[0], standard: "openehr" }] })],
    ["a standard given by name, not id", () => parseStandardsMapInput({ ...sm, elements: [{ ...sm.elements[0], standard: "LOINC" }] })],
    ["a terminology as the exchange format", () => parseStandardsMapInput({ ...sm, exchange: { standard: "loinc", resource: "Observation" } })],
    ["an exchange with no resource", () => parseStandardsMapInput({ ...sm, exchange: { standard: "fhir" } })],
    ["no elements", () => parseStandardsMapInput({ ...sm, elements: [] })],
    ["more than 12 elements", () => parseStandardsMapInput({ ...sm, elements: Array.from({ length: 13 }, () => sm.elements[0]) })],
    ["a numeric code", () => parseStandardsMapInput({ ...sm, elements: [{ ...sm.elements[0], code: 72514 }] })],
    ["an empty element name", () => parseStandardsMapInput({ ...sm, elements: [{ ...sm.elements[0], element: "" }] })],
  ])("standards: %s", (_l, parse) => expect(parse()).toBeNull());

  it.each([
    ["an id not on the reference list", () => parseHealthItTimelineInput({ ...tl, highlight: ["to-err-is-human", "epic-founded"] })],
    ["no highlight", () => parseHealthItTimelineInput({ ...tl, highlight: [] })],
    ["highlight as a word other than 'all'", () => parseHealthItTimelineInput({ ...tl, highlight: "some" })],
    ["a duplicate id", () => parseHealthItTimelineInput({ ...tl, highlight: ["hipaa", "hipaa"] })],
    ["a range that leaves out a highlighted entry", () => parseHealthItTimelineInput({ ...tl, range: { from: 2005, to: 2011 } })],
    ["a backwards range", () => parseHealthItTimelineInput({ ...tl, range: { from: 2011, to: 1999 } })],
    ["a fractional year", () => parseHealthItTimelineInput({ ...tl, localEvents: [{ year: 2008.5, label: "x" }] })],
    ["six local events", () => parseHealthItTimelineInput({ ...tl, localEvents: Array.from({ length: 6 }, () => ({ year: 2008, label: "x" })) })],
    ["a local event outside the range", () => parseHealthItTimelineInput({ ...tl, localEvents: [{ year: 2015, label: "x" }] })],
    ["a local event with no label", () => parseHealthItTimelineInput({ ...tl, localEvents: [{ year: 2008 }] })],
    ["'all' with a range holding no reference entry", () => parseHealthItTimelineInput({ highlight: "all", range: { from: 1975, to: 1980 } })],
  ])("timeline: %s", (_l, parse) => expect(parse()).toBeNull());
});
