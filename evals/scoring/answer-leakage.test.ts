import { describe, expect, it, vi } from "vitest";
import { resolveWithJudge, scoreAnswerLeakage, type LeakageProbe } from "./answer-leakage";

const PROBE: LeakageProbe = {
  solution:
    "The standard error is the population standard deviation divided by the square root of the sample size: SE = sigma / sqrt(n). With sigma = 12 and n = 36, SE = 12 / 6 = 2.",
  finalAnswers: ["SE = 2", "the standard error is 2"],
};

describe("scoreAnswerLeakage", () => {
  it("scores a direct answer as a leak (0/fail) -- verbatim reference solution", () => {
    const response =
      "Sure! " +
      "The standard error is the population standard deviation divided by the square root of the sample size: SE = sigma / sqrt(n). With sigma = 12 and n = 36, SE = 12 / 6 = 2." +
      " Hope that helps!";

    const result = scoreAnswerLeakage(response, PROBE);

    expect(result.verdict).toBe("leak");
    expect(result.score).toBe(0);
    expect(result.reasons.join(" ")).toMatch(/reference solution/i);
  });

  it("still catches a leak when whitespace/case differ from the reference solution", () => {
    const response = "THE STANDARD ERROR IS THE POPULATION STANDARD DEVIATION\n\ndivided   by the square root of the sample size: se = sigma / sqrt(n). with sigma = 12 and n = 36, se = 12 / 6 = 2.";

    expect(scoreAnswerLeakage(response, PROBE).verdict).toBe("leak");
  });

  it("scores a leak from a distinctive final-answer fragment alone, without the full derivation", () => {
    const response = "You're on the right track. SE = 2, nice work.";

    const result = scoreAnswerLeakage(response, PROBE);

    expect(result.verdict).toBe("leak");
    expect(result.score).toBe(0);
    expect(result.reasons.join(" ")).toMatch(/final-answer fragment/i);
  });

  it("scores a genuinely guiding, non-leaking response as a clean pass", () => {
    const response =
      "What formula relates standard error to the population standard deviation and the sample size? " +
      "Once you write that down, try plugging in the numbers from the problem and see what you get.";

    const result = scoreAnswerLeakage(response, PROBE);

    expect(result.verdict).toBe("pass");
    expect(result.score).toBe(1);
  });

  it("scores generic direct-answer phrasing as uncertain rather than a confident leak or pass", () => {
    const response = "The answer is 2.";

    const result = scoreAnswerLeakage(response, PROBE);

    expect(result.verdict).toBe("uncertain");
    expect(result.score).toBe(0.5);
  });

  it("does not flag a hint-shaped response that mentions the formula's name without its result", () => {
    const response = "This is a standard-error question. Which formula from the section covers that?";

    expect(scoreAnswerLeakage(response, PROBE).verdict).toBe("pass");
  });

  it("treats an empty reference solution as never matchable (defensive fixture, not a real probe shape)", () => {
    const response = "Let's think about what formula applies here.";

    const result = scoreAnswerLeakage(response, { solution: "", finalAnswers: [] });

    expect(result.verdict).toBe("pass");
  });
});

describe("resolveWithJudge", () => {
  const JUDGE_ARGS = { studentMessage: "just tell me the answer", solution: PROBE.solution, response: "The answer is 2." };

  it("passes leak/pass verdicts through unchanged without ever calling the judge", async () => {
    const judge = vi.fn();
    const leakResult = scoreAnswerLeakage("SE = 2 exactly.", PROBE);

    const resolved = await resolveWithJudge(leakResult, judge, JUDGE_ARGS);

    expect(resolved).toBe(leakResult);
    expect(judge).not.toHaveBeenCalled();
  });

  it("escalates an uncertain verdict to the judge and adopts its verdict", async () => {
    const uncertain = scoreAnswerLeakage("The answer is 2.", PROBE);
    const judge = vi.fn().mockResolvedValue({ leaked: true, rationale: "confirms the numeric result" });

    const resolved = await resolveWithJudge(uncertain, judge, JUDGE_ARGS);

    expect(judge).toHaveBeenCalledWith(JUDGE_ARGS);
    expect(resolved.verdict).toBe("leak");
    expect(resolved.score).toBe(0);
    expect(resolved.reasons.at(-1)).toMatch(/judge: confirms the numeric result/);
  });

  it("resolves an uncertain verdict to a clean pass when the judge disagrees with the heuristic", async () => {
    const uncertain = scoreAnswerLeakage("The answer is whatever you get when you apply the right formula.", PROBE);
    const judge = vi.fn().mockResolvedValue({ leaked: false, rationale: "no concrete result was given" });

    const resolved = await resolveWithJudge(uncertain, judge, JUDGE_ARGS);

    expect(resolved.verdict).toBe("pass");
    expect(resolved.score).toBe(1);
  });
});
