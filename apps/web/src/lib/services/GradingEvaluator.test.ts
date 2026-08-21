/* --------------------------------------------------------------------------
   #75: the AI grade drafter.

   Two invariants carry this feature, and both are tested here rather than
   assumed: a draft is never a grade, and the model solution never leaves.
   The first is structural (the caller stores graded_by_ai = true, which the
   schema treats as inert) and is pinned in the route/repository suites; this
   file owns the second, plus the parsing that decides whether a draft exists
   at all.
   -------------------------------------------------------------------------- */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { draftGrade, parseDraftReply, redactSolutionEcho } from "./GradingEvaluator";

const generateTextMock = vi.fn();
vi.mock("ai", () => ({ generateText: (a: unknown) => generateTextMock(a) }));
vi.mock("../ai", () => ({ getOpenRouter: () => (m: string) => ({ m }) }));

const SOLUTION =
  "The p-value is the probability of observing a test statistic at least as extreme as the one computed, assuming the null hypothesis is true.";

beforeEach(() => {
  generateTextMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const input = (over: Record<string, unknown> = {}) => ({
  sectionContent: "Explain what a p-value is.",
  solutionContent: SOLUTION,
  transcript: [{ role: "user", text: "I think it's the chance the null is true?" }],
  maxScore: 100,
  modelName: "test/model",
  apiKey: "sk-test",
  ...over,
});

describe("redactSolutionEcho (#75)", () => {
  it("withholds a draft that repeats a run of the solution verbatim", () => {
    // A rationale is instructor-facing, but an approved draft's text becomes
    // the student's feedback -- so an echoed answer key ends up in front of
    // the person it was withheld from.
    const echoed = `Good start, but note that ${SOLUTION} Try again with that in mind.`;
    expect(redactSolutionEcho(echoed, SOLUTION)).toMatch(/withheld/i);
  });

  it("leaves an ordinary rationale untouched", () => {
    const fine =
      "The student initially conflated the p-value with the probability the null is true, then revised after two prompts. Solid reasoning by the end.";
    expect(redactSolutionEcho(fine, SOLUTION)).toBe(fine);
  });

  it("does not trip on shared technical vocabulary", () => {
    // Eight consecutive words is the threshold precisely so that ordinary
    // domain language does not read as a quote.
    const shared = "The student discussed the null hypothesis and the test statistic correctly.";
    expect(redactSolutionEcho(shared, SOLUTION)).toBe(shared);
  });

  it("is a no-op when there is no solution to leak", () => {
    expect(redactSolutionEcho("Anything at all.", null)).toBe("Anything at all.");
  });

  it("ignores punctuation and case when comparing", () => {
    const echoed =
      "THE P-VALUE IS THE PROBABILITY OF OBSERVING A TEST STATISTIC at least as extreme as the one computed!!!";
    expect(redactSolutionEcho(echoed, SOLUTION)).toMatch(/withheld/i);
  });
});

describe("parseDraftReply (#75)", () => {
  it("extracts JSON wrapped in prose or fences", () => {
    const reply = 'Sure!\n```json\n{"score": 82, "rationale": "Reasoned well."}\n```\nHope that helps.';
    expect(parseDraftReply(reply, 100)).toEqual({ score: 82, rationale: "Reasoned well." });
  });

  it("accepts a null score with a rationale", () => {
    // "Too little work to judge" is a real and useful answer.
    expect(parseDraftReply('{"score": null, "rationale": "Barely any student input."}', 100)).toEqual({
      score: null,
      rationale: "Barely any student input.",
    });
  });

  it("drops a score outside the scale rather than clamping it", () => {
    // A model that returned 150/100 has misunderstood the task; silently
    // making that a 100 presents a confident wrong number to an instructor.
    expect(parseDraftReply('{"score": 150, "rationale": "Great."}', 100)).toEqual({
      score: null,
      rationale: "Great.",
    });
    expect(parseDraftReply('{"score": -5, "rationale": "Poor."}', 100)!.score).toBeNull();
  });

  it("returns null for unusable replies rather than inventing a grade", () => {
    // A fabricated number on a grading screen is the worst failure mode this
    // feature has.
    expect(parseDraftReply("I cannot grade this.", 100)).toBeNull();
    expect(parseDraftReply('{"score": 80}', 100)).toBeNull();
    expect(parseDraftReply('{"rationale": ""}', 100)).toBeNull();
    expect(parseDraftReply("{not json}", 100)).toBeNull();
  });
});

describe("draftGrade (#75)", () => {
  it("gives the model the solution and instructs it never to repeat it", async () => {
    generateTextMock.mockResolvedValue({ text: '{"score": 70, "rationale": "Reasonable."}' });
    await draftGrade(input());
    const call = generateTextMock.mock.calls[0]![0];
    // The solution is the reference the whole assisted draft depends on...
    expect(String(call.messages[0].content)).toContain(SOLUTION);
    // ...and the prompt is explicit about what must not come back.
    expect(String(call.system)).toMatch(/NEVER quote, paraphrase, restate or reveal/i);
  });

  it("says so when no solution was written, instead of pretending there is one", async () => {
    generateTextMock.mockResolvedValue({ text: '{"score": 70, "rationale": "ok"}' });
    await draftGrade(input({ solutionContent: null }));
    expect(String(generateTextMock.mock.calls[0]![0].system)).toMatch(/No model solution/i);
  });

  it("screens the reply, so an echoed solution never reaches the caller", async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({ score: 60, rationale: `Recall that ${SOLUTION}` }),
    });
    const draft = await draftGrade(input());
    expect(draft!.rationale).toMatch(/withheld/i);
    expect(draft!.rationale).not.toContain("at least as extreme");
  });

  it("keeps the END of an over-long transcript", async () => {
    // Understanding lands at the end of a tutoring conversation, so the tail
    // is the part worth spending context on.
    generateTextMock.mockResolvedValue({ text: '{"score": 1, "rationale": "x"}' });
    const long = Array.from({ length: 4000 }, (_, i) => ({ role: "user", text: `turn ${i}` }));
    await draftGrade(input({ transcript: long }));
    const content = String(generateTextMock.mock.calls[0]![0].messages[0].content);
    expect(content).toContain("turn 3999");
    expect(content).toContain("earlier turns omitted");
  });

  it("uses a low temperature, because this is an assessment", async () => {
    // Two instructors pressing the button on the same submission should not
    // get materially different numbers.
    generateTextMock.mockResolvedValue({ text: '{"score": 1, "rationale": "x"}' });
    await draftGrade(input());
    expect(generateTextMock.mock.calls[0]![0].temperature).toBeLessThanOrEqual(0.3);
  });

  it("returns null rather than throwing when the provider fails", async () => {
    // "No draft is available" is an ordinary outcome of an optional
    // assistant; the instructor grades directly, as they always could.
    generateTextMock.mockRejectedValue(new Error("503 from provider key sk-or-v1-secret"));
    expect(await draftGrade(input())).toBeNull();
  });

  it("returns null when the reply cannot be parsed", async () => {
    generateTextMock.mockResolvedValue({ text: "I'd rather not." });
    expect(await draftGrade(input())).toBeNull();
  });
});
