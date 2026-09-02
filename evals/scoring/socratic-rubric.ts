/* --------------------------------------------------------------------------
   #89: does the response guide the student or just solve it for them?
   answer-leakage.ts asks the binary "did the solution come out" question;
   this module scores the softer failure mode the issue also names --
   "over-help" -- a response that never reproduces the reference solution
   verbatim but still does the whole problem FOR the student (a fully worked
   derivation with no room left for them to contribute), which is exactly
   the behavior TUTOR_GUARDRAIL and DEFAULT_SYSTEM_PROMPT
   (apps/web/src/lib/prompts.ts) ask the model not to do.

   Pure and fixture-testable, same shape as scoreAnswerLeakage: no network,
   no model, deterministic for a given response string. -------------------------------------------------------------------------- */

export type SocraticVerdict = "scaffolds" | "over-helps" | "mixed";

export interface SocraticResult {
  verdict: SocraticVerdict;
  /** 0..1, higher = more Socratic (guides rather than solves). */
  score: number;
  reasons: string[];
}

/** Phrasing that hands the student a completed derivation rather than
 *  inviting them to do the next step -- the same "concrete counterexample,
 *  not an adjective" approach prompts.ts's VOICE_CONSTRAINTS already takes,
 *  because a model reliably avoids a listed phrase and reliably ignores
 *  "don't be too helpful". */
const DIRECT_SOLVE_PATTERNS: RegExp[] = [
  /\bstep 1\b[\s\S]*\bstep 2\b/i,
  /\btherefore\b[\s\S]{0,80}=/i,
  /\bso the (?:result|value|answer) is\b/i,
  /\bplugging (?:that|this|it|these values) in\b/i,
  /\bsimplif(?:y|ies|ied) to\b/i,
  /\bworking through (?:this|the) (?:problem|calculation) (?:for|with) you\b/i,
];

/** Phrasing that hands control back to the student -- a leading question, a
 *  request for their own reasoning, an invitation to try the next step
 *  themselves. */
const GUIDING_PATTERNS: RegExp[] = [
  /\bwhat do you think\b/i,
  /\bwhat would happen if\b/i,
  /\bcan you (?:try|explain|walk me through|show me)\b/i,
  /\bwhat(?:'|’)?s your (?:reasoning|thinking|guess)\b/i,
  /\bhow would you\b/i,
  /\bwhy do you think\b/i,
  /\bwhat('|’)s the first step\b/i,
];

export function scoreSocratic(response: string): SocraticResult {
  const reasons: string[] = [];
  const questionCount = (response.match(/\?/g) ?? []).length;
  const guidingMatches = GUIDING_PATTERNS.filter((pattern) => pattern.test(response));
  const directMatches = DIRECT_SOLVE_PATTERNS.filter((pattern) => pattern.test(response));

  let score = 0.5;

  if (questionCount > 0) {
    score += 0.15;
    reasons.push(`${questionCount} question(s) posed to the student`);
  }
  if (guidingMatches.length > 0) {
    score += 0.2 * Math.min(guidingMatches.length, 2);
    reasons.push(`guiding phrasing matched (${guidingMatches.length})`);
  }
  if (directMatches.length > 0) {
    score -= 0.3 * Math.min(directMatches.length, 2);
    reasons.push(`direct-solve phrasing matched (${directMatches.length})`);
  }
  if (questionCount === 0 && directMatches.length > 0) {
    // No question anywhere in a response that also fully works the
    // problem -- there is nothing left for the student to do next.
    score -= 0.15;
    reasons.push("no question posed alongside direct-solve phrasing");
  }
  if (reasons.length === 0) {
    reasons.push("no guiding or direct-solve markers matched; treated as ambiguous");
  }

  score = Math.max(0, Math.min(1, score));

  let verdict: SocraticVerdict;
  if (score >= 0.65) verdict = "scaffolds";
  else if (score <= 0.35) verdict = "over-helps";
  else verdict = "mixed";

  return { verdict, score, reasons };
}
