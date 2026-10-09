// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { MEASUREMENT_FIXTURES } from "./figure/fixtures.measurement";
import { parseAdoptionCurveInput, parseRunChartInput, parseUsabilityScoreInput } from "./toolInputs.measurement";
import { RunChart } from "./renderers/informatics/RunChart";
import { UsabilityScore } from "./renderers/informatics/UsabilityScore";
import { AdoptionCurve } from "./renderers/informatics/AdoptionCurve";

afterEach(cleanup);

const fig = () => screen.getByRole("figure");
const takeaway = () => fig().querySelector(".gen-figure__takeaway")!.textContent!;

describe("measurement fixtures parse and render inside a <figure>", () => {
  it.each([
    ["showRunChart", () => <RunChart {...parseRunChartInput(MEASUREMENT_FIXTURES.showRunChart)!} />],
    ["showUsabilityScore", () => <UsabilityScore {...parseUsabilityScoreInput(MEASUREMENT_FIXTURES.showUsabilityScore)!} />],
    ["showAdoptionCurve", () => <AdoptionCurve {...parseAdoptionCurveInput(MEASUREMENT_FIXTURES.showAdoptionCurve)!} />],
  ])("%s", (_name, el) => {
    render(el());
    expect(fig().getAttribute("aria-label")).toBeTruthy();
    expect(within(fig()).getByText("Show the numbers")).toBeTruthy();
    expect(fig().textContent).not.toMatch(/NaN|Infinity|undefined/);
  });

  it("every fixture has a parser that accepts it", () => {
    expect(Object.keys(MEASUREMENT_FIXTURES).sort()).toEqual(["showAdoptionCurve", "showRunChart", "showUsabilityScore"]);
  });
});

describe("run chart: computed, not trusted", () => {
  it("BCMA fixture: baseline median, a 12-point shift after the change, an improvement", () => {
    render(<RunChart {...parseRunChartInput(MEASUREMENT_FIXTURES.showRunChart)!} />);
    expect(takeaway()).toBe(
      "Median 89.25%, from the first 8 points (the baseline), extended to the rest. A shift of 12 points above the median began at Wk 9, after BCMA re-education: an improvement.",
    );
    expect(fig().getAttribute("aria-label")).toContain("A shift of 12 points above the median began at Wk 9");
    // The 12 signal points are ringed, not just coloured.
    expect(fig().querySelectorAll("circle.gen-ms-ring")).toHaveLength(12);
    expect(fig().textContent).toContain("Shift · 12 above");
    // The rate is computed from numerator / denominator.
    expect(fig().textContent).toContain("Wk 2038440096%AboveShift above");
  });

  it("no signal: says so and does not claim improvement", () => {
    const points = Array.from({ length: 12 }, (_, i) => ({ label: `Day ${i + 1}`, value: i % 2 === 0 ? 5 : 7 }));
    render(<RunChart measure="Falls per 1,000 patient-days" unit="falls" points={points} improvement="down" />);
    expect(takeaway()).toBe(
      "Median 6 falls, from all 12 points. No shift (6 or more points on one side of the median) and no trend (5 or more points all rising or all falling): no non-random signal yet, so this chart does not show an improvement.",
    );
    expect(fig().querySelectorAll("circle.gen-ms-ring")).toHaveLength(0);
  });

  it("shifts and a trend in order, each judged against the better direction", () => {
    // Falls from Day 4 (51) to Day 10 (41): 7 points.
    const values = [50, 52, 49, 51, 50, 48, 46, 44, 42, 41, 43, 42];
    render(
      <RunChart
        measure="Documentation time per shift"
        unit="min"
        points={values.map((value, i) => ({ label: `Day ${i + 1}`, value }))}
        improvement="down"
        changeAfter="Day 4"
        changeLabel="voice-to-text charting"
      />,
    );
    expect(takeaway()).toBe(
      "Median 47 min, from all 12 points. A shift of 6 points above the median began at Day 1, before voice-to-text charting: a change in the worse direction. A trend of 7 decreasing points began at Day 4, before voice-to-text charting: an improvement. A shift of 6 points below the median began at Day 7, after voice-to-text charting: an improvement.",
    );
  });

  it("with no better direction given, no signal is called an improvement", () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    render(<RunChart measure="Portal activations" points={values.map((value, i) => ({ label: `M${i + 1}`, value }))} />);
    const t = takeaway();
    expect(t).toContain("A trend of 10 increasing points began at M1.");
    expect(t).not.toContain("improvement");
    expect(fig().textContent).toContain("Which direction is better was not given");
  });
});

describe("SUS: computed, not trusted", () => {
  it("fixture: mean, range, comparison with 68, adjective basis and the weakest item", () => {
    render(<UsabilityScore {...parseUsabilityScoreInput(MEASUREMENT_FIXTURES.showUsabilityScore)!} />);
    expect(takeaway()).toBe(
      "Mean SUS score 62.3 from 12 respondents (range 30–80): 5.7 below the commonly cited average of 68. Nearest adjective: “Good” (in Bangor, Kortum & Miller, 2009, people who rated a system “Good” gave it a mean SUS of 71.4). The lowest-scoring item is 8, “I found the system very cumbersome to use.” (mean contribution 1.25 of 4).",
    );
    const stats = fig().querySelector(".gen-stats")!.textContent!;
    for (const s of ["Mean SUS62.3", "Range30–80", "Respondents12", "Nearest adjectiveGood"]) expect(stats).toContain(s);
    expect(fig().querySelectorAll("circle.gen-dot")).toHaveLength(12);
    // The figure owns the statements: every one appears in the table.
    expect(fig().textContent).toContain("I think that I would need the support of a technical person to be able to use this system.");
    expect(fig().textContent).toContain("not a diagnosis of what to fix");
  });

  it("a perfect score sits above the average", () => {
    render(<UsabilityScore systemName="Barcode scanner app" respondents={[[5, 1, 5, 1, 5, 1, 5, 1, 5, 1]]} />);
    expect(takeaway()).toContain("Mean SUS score 100.0 from 1 respondent (range 100): 32.0 above the commonly cited average of 68.");
    expect(takeaway()).toContain("“Best imaginable”");
    expect(takeaway()).toContain("The lowest-scoring items are 1, 2, 3, 4, 5, 6, 7, 8, 9 and 10 (mean contribution 4.00 of 4 each).");
  });
});

describe("adoption curve: computed, not trusted", () => {
  it("fixture: percent adopted, next category and when 16% was reached", () => {
    render(<AdoptionCurve {...parseAdoptionCurveInput(MEASUREMENT_FIXTURES.showAdoptionCurve)!} />);
    expect(takeaway()).toBe(
      "At 42% adopted (63 of 150 nurses), the next nurses to adopt are the early majority (16–50%); the 16% mark (early adopters done) was reached at Week 4.",
    );
    const statuses = [...fig().querySelectorAll(".gen-ms-cat__status")].map((n) => n.textContent);
    expect(statuses).toEqual(["Adopted", "Adopted", "Adopting next", "Not yet", "Not yet"]);
    expect(fig().textContent).toContain("not a prediction");
  });

  it("a single count, with no series chart", () => {
    render(<AdoptionCurve innovation="Patient portal enrolment at discharge" staffCount={40} adoptedCount={1} />);
    expect(takeaway()).toBe("At 2.5% adopted (1 of 40 staff), the next staff to adopt are the early adopters (2.5–16%).");
    expect(fig().querySelectorAll("svg")).toHaveLength(1);
  });

  it("nobody yet, and everybody", () => {
    render(<AdoptionCurve innovation="Secure messaging" staffCount={40} adoptedCount={0} staffLabel="nurses" />);
    expect(takeaway()).toBe("No nurses have adopted Secure messaging yet (0 of 40): the first to adopt would be the innovators (0–2.5%).");
    cleanup();
    render(<AdoptionCurve innovation="Secure messaging" staffCount={40} adoptedCount={40} staffLabel="nurses" />);
    expect(takeaway()).toBe("All 40 nurses have adopted Secure messaging (100%): every adopter category is reached.");
  });

  it("a mark already passed at the first count", () => {
    render(<AdoptionCurve innovation="Early warning score" staffCount={100} series={[{ label: "Jan", adoptedCount: 30 }, { label: "Feb", adoptedCount: 40 }]} />);
    expect(takeaway()).toBe(
      "At 40% adopted (40 of 100 staff), the next staff to adopt are the early majority (16–50%); the 16% mark (early adopters done) was already passed at the first count, Jan.",
    );
  });
});

describe("parsers refuse meaningless input", () => {
  const rc = MEASUREMENT_FIXTURES.showRunChart as { points: Array<Record<string, unknown>> } & Record<string, unknown>;
  const sus = MEASUREMENT_FIXTURES.showUsabilityScore as { respondents: number[][] } & Record<string, unknown>;
  const ad = MEASUREMENT_FIXTURES.showAdoptionCurve as { series: Array<Record<string, unknown>> } & Record<string, unknown>;

  it.each([
    ["fewer than 10 points", () => parseRunChartInput({ ...rc, points: rc.points.slice(0, 9), changeAfter: undefined, changeLabel: undefined, baselineCount: undefined })],
    ["more than 60 points", () => parseRunChartInput({ measure: "x", points: Array.from({ length: 61 }, (_, i) => ({ label: `${i}`, value: i })) })],
    ["a numerator above its denominator", () => parseRunChartInput({ ...rc, points: [{ label: "Wk 1", numerator: 401, denominator: 400 }, ...rc.points.slice(1)] })],
    ["a zero denominator", () => parseRunChartInput({ ...rc, points: [{ label: "Wk 1", numerator: 0, denominator: 0 }, ...rc.points.slice(1)] })],
    ["values mixed with rates", () => parseRunChartInput({ ...rc, points: [...rc.points.slice(0, 19), { label: "Wk 20", value: 96 }] })],
    ["a change after a point that does not exist", () => parseRunChartInput({ ...rc, changeAfter: "Wk 21" })],
    ["a change name with no place", () => parseRunChartInput({ ...rc, changeAfter: undefined })],
    ["a baseline of 5 points", () => parseRunChartInput({ ...rc, baselineCount: 5 })],
    ["a baseline longer than the data", () => parseRunChartInput({ ...rc, baselineCount: 21 })],
    ["duplicate labels", () => parseRunChartInput({ ...rc, points: [...rc.points.slice(0, 19), { ...rc.points[0] }] })],
    ["an unknown improvement direction", () => parseRunChartInput({ ...rc, improvement: "higher" })],
    ["a unit that contradicts a rate", () => parseRunChartInput({ ...rc, unit: "doses" })],
    ["a value sent as text", () => parseRunChartInput({ measure: "x", points: Array.from({ length: 10 }, (_, i) => ({ label: `${i}`, value: String(i) })) })],
  ])("run chart: %s", (_l, parse) => expect(parse()).toBeNull());

  it.each([
    ["nine answers", () => parseUsabilityScoreInput({ ...sus, respondents: [sus.respondents[0]!.slice(0, 9)] })],
    ["a response of 0", () => parseUsabilityScoreInput({ ...sus, respondents: [[0, 2, 4, 2, 4, 2, 4, 4, 4, 2]] })],
    ["a response of 6", () => parseUsabilityScoreInput({ ...sus, respondents: [[6, 2, 4, 2, 4, 2, 4, 4, 4, 2]] })],
    ["a fractional response", () => parseUsabilityScoreInput({ ...sus, respondents: [[3.5, 2, 4, 2, 4, 2, 4, 4, 4, 2]] })],
    ["no respondents", () => parseUsabilityScoreInput({ ...sus, respondents: [] })],
    ["more than 50 respondents", () => parseUsabilityScoreInput({ ...sus, respondents: Array.from({ length: 51 }, () => sus.respondents[0]) })],
    ["a precomputed score instead of responses", () => parseUsabilityScoreInput({ ...sus, respondents: [70, 52.5] })],
    ["no system name", () => parseUsabilityScoreInput({ ...sus, systemName: " " })],
  ])("SUS: %s", (_l, parse) => expect(parse()).toBeNull());

  it.each([
    ["adoption that falls", () => parseAdoptionCurveInput({ ...ad, series: [{ label: "W1", adoptedCount: 10 }, { label: "W2", adoptedCount: 8 }] })],
    ["more adopters than staff", () => parseAdoptionCurveInput({ ...ad, series: undefined, adoptedCount: 151 })],
    ["both a count and a series", () => parseAdoptionCurveInput({ ...ad, adoptedCount: 63 })],
    ["neither a count nor a series", () => parseAdoptionCurveInput({ ...ad, series: undefined })],
    ["no staff", () => parseAdoptionCurveInput({ ...ad, staffCount: 0 })],
    ["a fractional count", () => parseAdoptionCurveInput({ ...ad, series: undefined, adoptedCount: 2.5 })],
    ["a percentage instead of a count series", () => parseAdoptionCurveInput({ ...ad, series: [{ label: "W1", adoptedCount: 0.4 }, { label: "W2", adoptedCount: 0.5 }] })],
    ["a one-point series", () => parseAdoptionCurveInput({ ...ad, series: ad.series.slice(0, 1) })],
  ])("adoption: %s", (_l, parse) => expect(parse()).toBeNull());
});
