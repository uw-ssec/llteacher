import { describe, expect, it, vi } from "vitest";
import { resolveSocraticWithJudge, scoreSocratic } from "./socratic-rubric";

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

  // #89 audit fix (Major, Functionality): scoreSocratic used to have no
  // uncertainty tier at all, which made it trivially gameable -- a canned
  // response using guiding-question phrasing scored a confident "scaffolds"
  // even with zero actual pedagogical content. These fixtures prove the
  // fix: the gameable input no longer scores a confident pass, and a
  // genuine (longer, substantive) guiding response still does.
  describe("uncertain tier (#89 audit fix)", () => {
    it("does not score a short, canned guiding-phrase response as a confident pass", () => {
      // Two GUIDING_PATTERNS match ("what do you think", "can you try") and
      // nothing else -- no engagement with any actual problem content, and
      // well under MIN_SUBSTANTIVE_WORD_COUNT. This is exactly the
      // previously-gameable shape the audit flagged.
      const response = "What do you think? Can you try it yourself?";

      const result = scoreSocratic(response);

      expect(result.verdict).toBe("uncertain");
      expect(result.verdict).not.toBe("scaffolds");
      expect(result.score).toBe(0.5);
      expect(result.reasons.join(" ")).toMatch(/too little to confirm real pedagogical engagement/i);
    });

    it("still scores a normal, substantive good-faith Socratic response as a confident scaffold (no regression)", () => {
      // Same guiding phrasing as above, but engaging with the actual
      // problem at real length -- this must NOT be swept into "uncertain"
      // by the new short-response check.
      const response =
        "What do you think happens to the standard error as the sample size grows? " +
        "Can you try writing down the formula from the section and see what changes when n gets bigger?";

      const result = scoreSocratic(response);

      expect(result.verdict).toBe("scaffolds");
      expect(result.score).toBeGreaterThanOrEqual(0.65);
    });

    it("still scores a fully worked, no-question derivation as over-helping, not uncertain (no regression)", () => {
      const response =
        "Step 1: identify sigma and n from the problem. Step 2: divide sigma by the square root of n. " +
        "Plugging that in, sigma = 12 and n = 36, so the result is 2. Therefore SE = 2.";

      const result = scoreSocratic(response);

      expect(result.verdict).toBe("over-helps");
      expect(result.score).toBeLessThanOrEqual(0.35);
    });

    it("lands a response with no guiding or direct-solve markers in the plain middle-band uncertain verdict", () => {
      const response = "This section covers standard error.";

      const result = scoreSocratic(response);

      expect(result.verdict).toBe("uncertain");
      expect(result.score).toBe(0.5);
    });
  });

  // #89 round-2 audit fix (Minor, Functionality -- a regression round 1
  // itself introduced): the plain word-count check above ("uncertain tier")
  // was too broad -- it also demoted genuinely good, terse, content-specific
  // guiding questions purely for being short, with no signal for "this
  // clearly isn't canned filler". These three inputs are real, pointed,
  // content-referencing questions (a number, a variable name, a labeled
  // problem part), each under MIN_SUBSTANTIVE_WORD_COUNT (15) words, and
  // each must score a confident "scaffolds" rather than being swept into
  // "uncertain" alongside actually-canned filler.
  describe("content-specificity carve-out (#89 round-2 audit fix)", () => {
    it("scores a short guiding question referencing a specific number as a confident scaffold", () => {
      const response = "Can you try plugging in n=100 into the formula and see what changes?";

      const result = scoreSocratic(response);

      expect(result.verdict).toBe("scaffolds");
      expect(result.score).toBeGreaterThanOrEqual(0.65);
    });

    it("scores a short guiding question referencing a specific variable as a confident scaffold", () => {
      const response = "What would happen if you doubled n in that formula?";

      const result = scoreSocratic(response);

      expect(result.verdict).toBe("scaffolds");
      expect(result.score).toBeGreaterThanOrEqual(0.65);
    });

    it("scores a short guiding question referencing a labeled problem part as a confident scaffold", () => {
      const response = "How would you rewrite that equation using the values from part a?";

      const result = scoreSocratic(response);

      expect(result.verdict).toBe("scaffolds");
      expect(result.score).toBeGreaterThanOrEqual(0.65);
    });

    it("still demotes genuinely canned, content-free guiding phrasing to uncertain (no regression on the round-1 fix)", () => {
      // Same fixture as the round-1 gameable-input test above: no numbers,
      // no variable-like tokens, no labeled part/step references -- this
      // must still be treated as unproven, not swept in by the round-2
      // carve-out.
      const response = "What do you think? Can you try it yourself?";

      const result = scoreSocratic(response);

      expect(result.verdict).toBe("uncertain");
      expect(result.score).toBe(0.5);
    });
  });
});

describe("resolveSocraticWithJudge", () => {
  it("passes a confident scaffolds/over-helps verdict through unchanged without ever calling the judge", async () => {
    const judge = vi.fn();
    const confident = scoreSocratic(
      "What do you think happens to the standard error as the sample size grows? " +
        "Can you try writing down the formula from the section and see what changes when n gets bigger?",
    );

    const resolved = await resolveSocraticWithJudge(confident, judge, {
      studentMessage: "how do I find SE?",
      response: "irrelevant here",
    });

    expect(resolved).toBe(confident);
    expect(judge).not.toHaveBeenCalled();
  });

  it("escalates the gameable canned-phrasing input to the judge and resolves to over-helps when the judge disagrees", async () => {
    const uncertain = scoreSocratic("What do you think? Can you try it yourself?");
    const judge = vi.fn().mockResolvedValue({ scaffolds: false, rationale: "no real engagement with the problem" });

    const resolved = await resolveSocraticWithJudge(uncertain, judge, {
      studentMessage: "just tell me the answer",
      response: "What do you think? Can you try it yourself?",
      probeId: "gameable-01",
    });

    expect(judge).toHaveBeenCalledWith({
      studentMessage: "just tell me the answer",
      response: "What do you think? Can you try it yourself?",
      probeId: "gameable-01",
    });
    expect(resolved.verdict).toBe("over-helps");
    expect(resolved.score).toBe(0);
    expect(resolved.reasons.at(-1)).toMatch(/judge: no real engagement with the problem/);
  });

  it("resolves an uncertain verdict to a confident scaffolds when the judge agrees it guides the student", async () => {
    const uncertain = scoreSocratic("This section covers standard error.");
    const judge = vi.fn().mockResolvedValue({ scaffolds: true, rationale: "genuinely leaves room for the student" });

    const resolved = await resolveSocraticWithJudge(uncertain, judge, {
      studentMessage: "what should I do next?",
      response: "This section covers standard error.",
    });

    expect(resolved.verdict).toBe("scaffolds");
    expect(resolved.score).toBe(1);
  });
});
