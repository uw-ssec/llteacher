// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { FRAMEWORKS_FIXTURES } from "./figure/fixtures.frameworks";
import { parseDikwInput, parseQuadrupleAimInput, parseSociotechnicalInput } from "./toolInputs.frameworks";
import { QuadrupleAim } from "./renderers/informatics/QuadrupleAim";
import { SociotechnicalModel } from "./renderers/informatics/SociotechnicalModel";
import { Dikw } from "./renderers/informatics/Dikw";

afterEach(cleanup);

const text = () => screen.getByRole("figure").textContent!;
const fig = () => screen.getByRole("figure");

describe("framework fixtures parse and render inside a <figure>", () => {
  it.each([
    ["showQuadrupleAim", () => <QuadrupleAim {...parseQuadrupleAimInput(FRAMEWORKS_FIXTURES.showQuadrupleAim)!} />],
    ["showSociotechnicalModel", () => <SociotechnicalModel {...parseSociotechnicalInput(FRAMEWORKS_FIXTURES.showSociotechnicalModel)!} />],
    ["showDikw", () => <Dikw {...parseDikwInput(FRAMEWORKS_FIXTURES.showDikw)!} />],
  ])("%s", (_name, el) => {
    render(el());
    expect(fig().getAttribute("aria-label")).toBeTruthy();
    expect(within(fig()).getByText("Show the numbers")).toBeTruthy();
  });

  it("every fixture has a parser that accepts it", () => {
    expect(Object.keys(FRAMEWORKS_FIXTURES).sort()).toEqual(["showDikw", "showQuadrupleAim", "showSociotechnicalModel"]);
    expect(parseQuadrupleAimInput(FRAMEWORKS_FIXTURES.showQuadrupleAim)).not.toBeNull();
    expect(parseSociotechnicalInput(FRAMEWORKS_FIXTURES.showSociotechnicalModel)).not.toBeNull();
    expect(parseDikwInput(FRAMEWORKS_FIXTURES.showDikw)).not.toBeNull();
  });
});

describe("computed, not trusted", () => {
  it("Quadruple Aim: tally, trade-off and the effect in words and symbols", () => {
    render(<QuadrupleAim {...parseQuadrupleAimInput(FRAMEWORKS_FIXTURES.showQuadrupleAim)!} />);
    expect(screen.getByRole("figure").querySelector(".gen-figure__takeaway")!.textContent).toBe(
      "Improves 3 of 4 aims; trade-off: care team well-being (worsens).",
    );
    const effects = [...fig().querySelectorAll(".gen-fw-aim__effect")].map((n) => n.textContent);
    expect(effects).toEqual(["↑Improves", "↑Improves", "↑Improves", "↓WorsensTrade-off"]);
    const names = [...fig().querySelectorAll(".gen-fw-aim__name")].map((n) => n.textContent);
    expect(names).toEqual(["Patient experience of care", "Population health", "Cost of care", "Care team well-being"]);
    expect(fig().querySelector(".gen-stats")!.textContent).toBe("↑ Improves3↓ Worsens1↕ Mixed0? Unclear0");
    expect(fig().getAttribute("aria-label")).toContain("Care team well-being worsens");
    expect(fig().querySelector(".gen-figure__kicker")!.textContent).toBe("Quadruple Aim");
  });

  it("Quadruple Aim: equity as a fifth aim", () => {
    const input = FRAMEWORKS_FIXTURES.showQuadrupleAim as { aims: Record<string, unknown> };
    const parsed = parseQuadrupleAimInput({
      ...input,
      includeEquity: true,
      aims: { ...input.aims, healthEquity: { effect: "mixed", rationale: "Scanners work in every room, but alerts are English-only.", measure: "Error rate by preferred language" } },
    });
    render(<QuadrupleAim {...parsed!} />);
    expect(fig().querySelectorAll(".gen-fw-aim")).toHaveLength(5);
    expect(fig().querySelector(".gen-figure__kicker")!.textContent).toBe("Quintuple Aim");
    expect(text()).toContain("Improves 3 of 5 aims; trade-offs: care team well-being (worsens) and health equity (mixed).");
  });

  it("sociotechnical model: all eight dimensions, the unsupplied one not assessed", () => {
    render(<SociotechnicalModel {...parseSociotechnicalInput(FRAMEWORKS_FIXTURES.showSociotechnicalModel)!} />);
    expect(fig().querySelector(".gen-figure__takeaway")!.textContent).toBe(
      "4 of 8 dimensions contribute to the problem: infrastructure (1), clinical content (2), human–computer interface (3) and workflow and communication (5). 2 protective: people (4) and measurement and monitoring (8). 2 not assessed.",
    );
    const roles = [...fig().querySelectorAll(".gen-fw-stm__role")].map((n) => n.textContent);
    expect(roles).toEqual([
      "! Contributing", "! Contributing", "! Contributing", "✓ Protective", "! Contributing", "– Not assessed", "– Not assessed", "✓ Protective",
    ]);
    expect(fig().querySelectorAll(".gen-fw-stm__strip > li")).toHaveLength(8);
    expect(text()).toContain("interdependent: a fix in one usually needs changes in others");
    expect(fig().querySelector(".gen-fw-stm__key")!.textContent).toBe("!Contributing (4)✓Protective (2)–Not assessed (2)");
  });

  it("DIKW: four levels in order, takeaway from the inputs, the action last", () => {
    render(<Dikw {...parseDikwInput(FRAMEWORKS_FIXTURES.showDikw)!} />);
    const names = [...fig().querySelectorAll(".gen-fw-dikw__name")].map((n) => n.textContent);
    expect(names).toEqual(["Data", "Information", "Knowledge", "Wisdom"]);
    expect(fig().querySelector(".gen-figure__takeaway")!.textContent).toBe(
      "From data (HR 118, RR 24, temp 38.6 °C, SBP 94, new confusion) to wisdom (Do not wait for the next scheduled check: escalate now and start the sepsis protocol): 4 levels, each built on the one before. Resulting action: Calls the rapid response team and draws blood cultures and a lactate.",
    );
    expect(fig().querySelector(".gen-fw-dikw__action")!.textContent).toContain("Calls the rapid response team");
  });

  it("DIKW: no action, no action box", () => {
    const input = FRAMEWORKS_FIXTURES.showDikw as Record<string, unknown>;
    render(<Dikw {...parseDikwInput({ scenario: input.scenario, examples: input.examples })!} />);
    expect(fig().querySelector(".gen-fw-dikw__action")).toBeNull();
    expect(text()).not.toContain("Resulting action");
  });
});

describe("parsers refuse meaningless input", () => {
  const qa = FRAMEWORKS_FIXTURES.showQuadrupleAim as { aims: Record<string, Record<string, unknown>> };
  const stm = FRAMEWORKS_FIXTURES.showSociotechnicalModel as { findings: Array<Record<string, unknown>> };
  const dk = FRAMEWORKS_FIXTURES.showDikw as { examples: Record<string, unknown> };
  const pe = qa.aims.patientExperience!;

  it.each([
    ["an unknown effect", () => parseQuadrupleAimInput({ ...qa, aims: { ...qa.aims, patientExperience: { ...pe, effect: "helps" } } })],
    ["a missing aim", () => parseQuadrupleAimInput({ ...qa, aims: { patientExperience: pe, populationHealth: pe, costOfCare: pe } })],
    ["an aim the framework does not have", () => parseQuadrupleAimInput({ ...qa, aims: { ...qa.aims, patientSafety: pe } })],
    ["equity assessed without includeEquity", () => parseQuadrupleAimInput({ ...qa, aims: { ...qa.aims, healthEquity: pe } })],
    ["includeEquity without an equity assessment", () => parseQuadrupleAimInput({ ...qa, includeEquity: true })],
    ["includeEquity as text", () => parseQuadrupleAimInput({ ...qa, includeEquity: "yes" })],
    ["an empty rationale", () => parseQuadrupleAimInput({ ...qa, aims: { ...qa.aims, costOfCare: { ...pe, rationale: " " } } })],
    ["no measure", () => parseQuadrupleAimInput({ ...qa, aims: { ...qa.aims, costOfCare: { effect: "improves", rationale: "r" } } })],
    ["no intervention", () => parseQuadrupleAimInput({ ...qa, intervention: "" })],
    ["aims as an array", () => parseQuadrupleAimInput({ ...qa, aims: Object.values(qa.aims) })],
  ])("Quadruple Aim: %s", (_l, parse) => expect(parse()).toBeNull());

  it.each([
    ["an unknown dimension", () => parseSociotechnicalInput({ ...stm, findings: [{ dimension: "leadership", role: "contributing", finding: "f" }] })],
    ["a dimension given as its number", () => parseSociotechnicalInput({ ...stm, findings: [{ dimension: 3, role: "contributing", finding: "f" }] })],
    ["a duplicate dimension", () => parseSociotechnicalInput({ ...stm, findings: [stm.findings[0], stm.findings[0]] })],
    ["zero dimensions assessed", () => parseSociotechnicalInput({ ...stm, findings: [{ dimension: "people", role: "not assessed" }] })],
    ["no findings", () => parseSociotechnicalInput({ ...stm, findings: [] })],
    ["an unknown role", () => parseSociotechnicalInput({ ...stm, findings: [{ dimension: "people", role: "causal", finding: "f" }] })],
    ["a contributing dimension with no finding", () => parseSociotechnicalInput({ ...stm, findings: [{ dimension: "people", role: "contributing" }] })],
    ["no case title", () => parseSociotechnicalInput({ findings: stm.findings })],
    ["more than eight findings", () => parseSociotechnicalInput({ ...stm, findings: Array.from({ length: 9 }, () => stm.findings[0]) })],
  ])("sociotechnical: %s", (_l, parse) => expect(parse()).toBeNull());

  it.each([
    ["a missing level", () => parseDikwInput({ ...dk, examples: { ...dk.examples, knowledge: undefined } })],
    ["an empty example", () => parseDikwInput({ ...dk, examples: { ...dk.examples, wisdom: "  " } })],
    ["a level the framework does not have", () => parseDikwInput({ ...dk, examples: { ...dk.examples, understanding: "u" } })],
    ["the same example at two levels", () => parseDikwInput({ ...dk, examples: { ...dk.examples, information: dk.examples.data } })],
    ["an example that is a number", () => parseDikwInput({ ...dk, examples: { ...dk.examples, data: 118 } })],
    ["no scenario", () => parseDikwInput({ ...dk, scenario: "" })],
    ["an action that is not text", () => parseDikwInput({ ...dk, action: true })],
    ["examples as an array", () => parseDikwInput({ ...dk, examples: ["a", "b", "c", "d"] })],
  ])("DIKW: %s", (_l, parse) => expect(parse()).toBeNull());
});
