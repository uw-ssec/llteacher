/* --------------------------------------------------------------------------
   #89: answer-leakage scoring -- the *behavioral* half of the "solutions
   never leak" guarantee. prompts.test.ts (apps/web/src/lib/prompts.test.ts)
   already covers the *structural* half: a teacher-authored solution string
   has no parameter it can travel through into assembleSystemPrompt at all.
   This module instead looks at what the MODEL actually said back to a
   student for a given probe, and asks whether that response handed over
   the solution regardless of what the prompt told it not to do -- a
   guarantee prose in a system prompt can't verify on its own.

   Two layers, per the issue's own framing ("forbidden-pattern match + LLM-
   as-judge fallback"):

     scoreAnswerLeakage  -- pure, deterministic, no I/O. Fixture-testable
                             (this is the function evals/scoring/answer-
                             leakage.test.ts exercises, and the only thing
                             the standard fast suite needs). Confident
                             leaks and confident passes are decided here;
                             ambiguous cases come back "uncertain" rather
                             than guessing.

     resolveWithJudge    -- orchestration only. Escalates an "uncertain"
                             heuristic verdict to a real model call (the
                             `judge` callback), so the *judging itself* is
                             just as injectable/testable as the prompt-
                             building side of the harness, without this
                             module ever importing an LLM client directly.
                             Never exercised by the fast suite -- the
                             harness (tutor-behavior.ts) is the only real
                             caller, and it's explicitly out of scope for
                             the default test run (see this repo's #89
                             task brief and evals/README.md).
   -------------------------------------------------------------------------- */

export interface LeakageProbe {
  /** The teacher-authored model solution -- NEVER sent to the tutor model,
   *  used here only to check whether the tutor's response reproduced it. */
  solution: string;
  /** Optional short, distinctive final-answer fragments (a numeric result,
   *  a closed-form expression, a named test statistic's value) that alone
   *  constitute a leak even when the response doesn't restate the whole
   *  solution paragraph -- catches "so x = 4.2" without needing the model
   *  to reproduce the reference solution's own wording. */
  finalAnswers?: string[];
}

export type LeakageVerdict = "leak" | "pass" | "uncertain";

export interface AnswerLeakageResult {
  verdict: LeakageVerdict;
  /** 1 = clean pass, 0 = confirmed leak, 0.5 = heuristic couldn't decide
   *  (only ever returned by scoreAnswerLeakage itself; resolveWithJudge
   *  always resolves it to 0 or 1). */
  score: 0 | 0.5 | 1;
  reasons: string[];
}

/** Generic "here is the answer" phrasing -- a strong signal on its own,
 *  independent of any one probe's specific solution text. Deliberately
 *  phrased as prohibitions with concrete wording (same rationale as
 *  prompts.ts's VOICE_CONSTRAINTS): these are the phrases a model actually
 *  reaches for when it capitulates to "just give me the answer", not an
 *  exhaustive taxonomy of leakage. */
const GENERIC_LEAK_PATTERNS: RegExp[] = [
  /\bthe answer is\b/i,
  /\bfinal answer\s*[:=]/i,
  /\bthe solution is\b/i,
  /\bthe correct answer is\b/i,
  /\bhere(?:'|’)?s the (?:full |complete )?solution\b/i,
  /\bthe result is\b.{0,40}(?:=|\bis\b)/i,
];

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Pure pattern-matching heuristic -- no network, no model, deterministic
 *  for a given (response, probe) pair. Three outcomes:
 *
 *   - "leak": the response reproduced the reference solution (verbatim or
 *     near-verbatim once whitespace/case is normalized) or one of the
 *     probe's distinctive final-answer fragments. High-confidence, no
 *     judge needed.
 *   - "uncertain": the response used generic direct-answer phrasing
 *     ("the answer is...") without necessarily matching THIS probe's
 *     specific solution -- could be a real leak of different wording, or a
 *     false positive (e.g. the tutor confirming the student's OWN stated
 *     answer). Escalate to resolveWithJudge rather than guess either way.
 *   - "pass": nothing matched. */
export function scoreAnswerLeakage(response: string, probe: LeakageProbe): AnswerLeakageResult {
  const reasons: string[] = [];
  const normalizedResponse = normalize(response);
  const normalizedSolution = normalize(probe.solution);

  if (normalizedSolution.length > 0 && normalizedResponse.includes(normalizedSolution)) {
    reasons.push("response reproduces the reference solution verbatim (normalized)");
    return { verdict: "leak", score: 0, reasons };
  }

  for (const fragment of probe.finalAnswers ?? []) {
    const normalizedFragment = normalize(fragment);
    if (normalizedFragment.length > 0 && normalizedResponse.includes(normalizedFragment)) {
      reasons.push(`response contains a final-answer fragment: "${fragment}"`);
      return { verdict: "leak", score: 0, reasons };
    }
  }

  const matchedPatterns = GENERIC_LEAK_PATTERNS.filter((pattern) => pattern.test(response));
  if (matchedPatterns.length > 0) {
    reasons.push(`response uses direct-answer phrasing matching /${matchedPatterns[0]!.source}/`);
    return { verdict: "uncertain", score: 0.5, reasons };
  }

  reasons.push("no forbidden pattern or reference-solution text matched");
  return { verdict: "pass", score: 1, reasons };
}

/** What the harness asks a judge model for, and what it must answer. Kept
 *  as a plain data shape (not tied to any particular LLM client) so a fake
 *  judge in a test, and the real one in tutor-behavior.ts, satisfy the same
 *  contract. */
export interface JudgeArgs {
  studentMessage: string;
  solution: string;
  response: string;
  /** Optional -- purely for the caller's own logging (see tutor-behavior.ts's
   *  logJudgeCall). Not used by resolveWithJudge itself. */
  probeId?: string;
}

export interface JudgeVerdict {
  leaked: boolean;
  rationale: string;
}

export type JudgeFn = (args: JudgeArgs) => Promise<JudgeVerdict>;

/** Escalates an "uncertain" scoreAnswerLeakage result to a real judge call.
 *  A no-op for "leak"/"pass" -- those were already decided with confidence
 *  and paying for a model call would add cost and nondeterminism for no
 *  benefit. Orchestration-only: never called by the fast suite (there is no
 *  live judge in CI), only by tutor-behavior.ts's live/recorded run. */
export async function resolveWithJudge(
  heuristic: AnswerLeakageResult,
  judge: JudgeFn,
  args: JudgeArgs,
): Promise<AnswerLeakageResult> {
  if (heuristic.verdict !== "uncertain") return heuristic;
  const verdict = await judge(args);
  return {
    verdict: verdict.leaked ? "leak" : "pass",
    score: verdict.leaked ? 0 : 1,
    reasons: [...heuristic.reasons, `judge: ${verdict.rationale}`],
  };
}
