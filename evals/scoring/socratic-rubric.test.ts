import { describe, expect, it } from "vitest";
import { scoreSocratic } from "./socratic-rubric";

describe("scoreSocratic", () => {
  it("scores a guiding, question-driven response as scaffolding", () => {
    const response =
      "What do you think happens to the standard error as the sample size grows? " +
      "Can you try writing down the formula from the section and see what changes when n gets bigger?";

    const result = scoreSocratic(response);

    expect(result.verdict).toBe("scaffolds");
    expect(result.score).toBeGreaterThanOrEqual(0.65);
  });

  it("scores a fully worked, no-question derivation as over-helping", () => {
    const response =
      "Step 1: identify sigma and n from the problem. Step 2: divide sigma by the square root of n. " +
      "Plugging that in, sigma = 12 and n = 36, so the result is 2. Therefore SE = 2.";

    const result = scoreSocratic(response);

    expect(result.verdict).toBe("over-helps");
    expect(result.score).toBeLessThanOrEqual(0.35);
  });

  it("scores the guiding response strictly higher than the direct-solve response for the same problem", () => {
    const guiding = "What formula relates SE to sigma and n? What do you get when you try it yourself?";
    const direct =
      "Step 1: take sigma. Step 2: divide by sqrt(n). Plugging in the numbers, therefore SE = 2. So the result is 2.";

    expect(scoreSocratic(guiding).score).toBeGreaterThan(scoreSocratic(direct).score);
  });

  it("scores a response with both a worked step and a follow-up question as mixed, not a confident scaffold", () => {
    const response =
      "Step 1: divide sigma by the square root of n. Therefore SE = 2. What would change if n were 144 instead?";

    const result = scoreSocratic(response);

    expect(result.verdict).not.toBe("scaffolds");
  });

  it("does not crash and returns a mid score for a response with no guiding or direct-solve markers at all", () => {
    const response = "This section covers standard error.";

    const result = scoreSocratic(response);

    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(1);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("clamps the score into [0, 1] even for a response stacking many direct-solve markers", () => {
    const response =
      "Step 1... Step 2... plugging in gives, therefore x = 1, simplifies to 2, so the result is 3, therefore y = 4.";

    const result = scoreSocratic(response);

    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });
});
