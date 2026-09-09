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
   no model, deterministic for a given response string.

   #89 audit fix (Major, Functionality): this used to be a purely additive/
   subtractive scorer with hard 0.65/0.35 pass/fail thresholds and no
   uncertainty tier -- unlike scoreAnswerLeakage (same directory), which
   returns "uncertain" for an ambiguous heuristic verdict instead of forcing
   a binary call, and leaves the tie-break to resolveWithJudge. That made
   this rubric trivially gameable: a canned response using guiding-question
   phrasing ("What do you think...", "Can you walk me through...") scored a
   confident "scaffolds" even with zero actual pedagogical content, because
   the score was driven entirely by pattern matches with no signal for
   "is there anything here besides the pattern".

   This now mirrors scoreAnswerLeakage's exact escalation pattern:
     - a verdict of "uncertain" (not "scaffolds"/"over-helps") for anything
       the heuristic can't confidently call one way or the other -- both the
       original 0.35..0.65 middle band, AND (new) a response that only
       reaches "scaffolds" territory via guiding-pattern matches on a short,
       otherwise-empty response (the gaming case above);
     - a resolveSocraticWithJudge escalation function with the same shape as
       resolveWithJudge: a no-op for a confident verdict, and a real judge
       call (only reached from tutor-behavior.ts's live mode, never the fast
       suite) that resolves "uncertain" to a confident 0/1 score.
   This is a second, socratic-specific function rather than a reuse of
   resolveWithJudge itself -- the two rubrics ask the judge different
   questions ("did this leak the solution" vs. "did this guide or solve for
   the student") and JudgeVerdict's `leaked: boolean` field doesn't fit the
   socratic question -- but the pattern (heuristic returns "uncertain" ->
   caller conditionally escalates to a judge -> judge resolves to a
   confident, discrete score) is identical, so tutor-behavior.ts's harness
   loop handles both rubrics the same way instead of needing two different
   kinds of escalation logic.
   -------------------------------------------------------------------------- */

export type SocraticVerdict = "scaffolds" | "over-helps" | "uncertain";

export interface SocraticResult {
  verdict: SocraticVerdict;
  /** 0..1, higher = more Socratic (guides rather than solves). For an
   *  "uncertain" verdict produced by the shallow-canned-phrasing check
   *  (see isShallowGuiding below) this is pinned to UNCERTAIN_SCORE, the
   *  same way scoreAnswerLeakage always returns exactly 0.5 for its own
   *  "uncertain" verdict -- for the plain middle-band case it stays the
   *  raw computed score, since that number is diagnostically useful (how
   *  close to a confident call it landed) and scoreAnswerLeakage has no
   *  equivalent graded score to preserve. */
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

// Named weights (#89 audit fix, Major/Functionality): these were inline
// literals (`score += 0.15`, `0.2 * min(matches, 2)`, ...) scattered through
// scoreSocratic. Pulled out so the scoring rationale is legible in one place
// and the weights are a single edit point rather than magic numbers.
const NEUTRAL_BASE_SCORE = 0.5;
const QUESTION_ASKED_BONUS = 0.15;
const GUIDING_PATTERN_BONUS_PER_MATCH = 0.2;
const GUIDING_PATTERN_BONUS_MAX_MATCHES = 2;
const DIRECT_SOLVE_PENALTY_PER_MATCH = 0.3;
const DIRECT_SOLVE_PENALTY_MAX_MATCHES = 2;
const NO_QUESTION_WITH_DIRECT_SOLVE_PENALTY = 0.15;

// Verdict thresholds. A raw score >= SCAFFOLDS_THRESHOLD or
// <= OVER_HELPS_THRESHOLD is a confident call; anything strictly between
// them is the "uncertain" middle band scoreAnswerLeakage's sibling logic
// already has a name for.
const SCAFFOLDS_THRESHOLD = 0.65;
const OVER_HELPS_THRESHOLD = 0.35;

/** The score an "uncertain" verdict reports for the shallow-canned-phrasing
 *  case -- deliberately the same 0.5 scoreAnswerLeakage's "uncertain"
 *  verdict always reports, rather than the (misleadingly confident) raw
 *  computed score. */
const UNCERTAIN_SCORE = 0.5;

/** Below this word count, guiding-pattern matches alone are not enough
 *  evidence of real pedagogical engagement -- "What do you think? Can you
 *  try it yourself?" matches two GUIDING_PATTERNS and nothing else, which
 *  is exactly the canned, content-free phrasing the audit flagged as
 *  trivially gameable. A genuine guiding response engages with the actual
 *  problem (see the fixtures: the shortest genuine "scaffolds" case in this
 *  file's tests is well over this threshold), so a short response driven
 *  entirely by pattern matches with no direct-solve content either is
 *  treated as unproven rather than a confident pass -- UNLESS it references
 *  something content-specific (see CONTENT_SPECIFICITY_PATTERNS below),
 *  which is real evidence of engagement no matter how short the response
 *  is. */
const MIN_SUBSTANTIVE_WORD_COUNT = 15;

// #89 round-2 audit fix (Minor, Functionality -- round 1 itself introduced
// this regression): the word-count-only isShallowGuiding check above was too
// broad -- it also demoted genuinely good, terse, content-specific guiding
// questions ("Can you try plugging in n=100 into the formula and see what
// changes?", "What would happen if you doubled n in that formula?", "How
// would you rewrite that equation using the values from part a?") purely
// for being short, even though each one clearly references concrete problem
// content and is nothing like the canned "What do you think? Can you try it
// yourself?" filler the check exists to catch.
//
// scoreSocratic only ever receives the response text (see its signature
// below -- tutor-behavior.ts's call site passes no problem/prior-turn
// context), so there is no problem text to match a response's words against
// directly. This is the general fallback heuristic instead: a short
// guiding response is treated as content-specific (not canned) if it
// contains a number, a short variable-name-like token (`n`, `x`, `f(x)`),
// or a labeled reference to a specific part/step of the problem (`part a`,
// `step 2`). Canned filler phrasing has none of these -- it never names a
// number, a variable, or a labeled part, which is exactly what makes it
// canned.
const CONTENT_SPECIFICITY_PATTERNS: RegExp[] = [
  /\d/, // any digit -- "n=100", "step 2", "doubled to 40"
  /\b[a-zA-Z]\(\s*[a-zA-Z0-9]*\s*\)/, // function notation -- f(x), g(t)
  /\b(?:part|step|equation|formula)\s+[a-z0-9]\b/i, // labeled reference -- "part a", "step b"
  /\b[a-hj-zA-HJ-Z]\b/, // a short variable-name-like token: a single letter
  // other than "a"/"I", which are common English words on their own and
  // not reliable evidence of a variable reference.
];

function wordCount(text: string): number {
  return text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;
}

/** True if `text` contains a number, a short variable-name-like token, or a
 *  labeled part/step reference -- see CONTENT_SPECIFICITY_PATTERNS above for
 *  why this is the fallback signal scoreSocratic uses instead of matching
 *  against the problem text directly. */
function hasContentSpecificReference(text: string): boolean {
  return CONTENT_SPECIFICITY_PATTERNS.some((pattern) => pattern.test(text));
}

export function scoreSocratic(response: string): SocraticResult {
  const reasons: string[] = [];
  const questionCount = (response.match(/\?/g) ?? []).length;
  const guidingMatches = GUIDING_PATTERNS.filter((pattern) => pattern.test(response));
  const directMatches = DIRECT_SOLVE_PATTERNS.filter((pattern) => pattern.test(response));

  let score = NEUTRAL_BASE_SCORE;

  if (questionCount > 0) {
    score += QUESTION_ASKED_BONUS;
    reasons.push(`${questionCount} question(s) posed to the student`);
  }
  if (guidingMatches.length > 0) {
    score += GUIDING_PATTERN_BONUS_PER_MATCH * Math.min(guidingMatches.length, GUIDING_PATTERN_BONUS_MAX_MATCHES);
    reasons.push(`guiding phrasing matched (${guidingMatches.length})`);
  }
  if (directMatches.length > 0) {
    score -= DIRECT_SOLVE_PENALTY_PER_MATCH * Math.min(directMatches.length, DIRECT_SOLVE_PENALTY_MAX_MATCHES);
    reasons.push(`direct-solve phrasing matched (${directMatches.length})`);
  }
  if (questionCount === 0 && directMatches.length > 0) {
    // No question anywhere in a response that also fully works the
    // problem -- there is nothing left for the student to do next.
    score -= NO_QUESTION_WITH_DIRECT_SOLVE_PENALTY;
    reasons.push("no question posed alongside direct-solve phrasing");
  }
  if (reasons.length === 0) {
    reasons.push("no guiding or direct-solve markers matched; treated as ambiguous");
  }

  score = Math.max(0, Math.min(1, score));

  // #89 audit fix: guiding-pattern matches with no direct-solve content and
  // not much text at all is exactly the gameable shape the audit called
  // out -- a canned "What do you think? Can you try it yourself?" costs
  // nothing to produce and previously scored a confident "scaffolds" purely
  // off two pattern matches. Escalate instead of trusting the raw score --
  // UNLESS (round-2 fix) the short response references something
  // content-specific, which is real evidence it isn't canned filler.
  const isBriefGuidingResponse =
    guidingMatches.length > 0 && directMatches.length === 0 && wordCount(response) < MIN_SUBSTANTIVE_WORD_COUNT;
  const isBriefButContentSpecific = isBriefGuidingResponse && hasContentSpecificReference(response);
  const isShallowGuiding = isBriefGuidingResponse && !isBriefButContentSpecific;

  if (isBriefButContentSpecific) {
    reasons.push(
      `short guiding response (${wordCount(response)} word(s)) but references specific content ` +
        "(a number, variable-like token, or labeled part/step) -- not treated as canned filler",
    );
  }

  let verdict: SocraticVerdict;
  if (isShallowGuiding) {
    verdict = "uncertain";
    score = UNCERTAIN_SCORE;
    reasons.push(
      `guiding phrasing matched but response is only ${wordCount(response)} word(s) with no direct-solve content -- ` +
        "too little to confirm real pedagogical engagement rather than canned phrasing; treated as uncertain",
    );
  } else if (score >= SCAFFOLDS_THRESHOLD) {
    verdict = "scaffolds";
  } else if (score <= OVER_HELPS_THRESHOLD) {
    verdict = "over-helps";
  } else {
    verdict = "uncertain";
  }

  return { verdict, score, reasons };
}

/** What the harness asks a judge model for, and what it must answer, when
 *  escalating an "uncertain" socratic verdict. Kept as a plain data shape
 *  (not tied to any particular LLM client), same rationale as answer-
 *  leakage.ts's JudgeArgs/JudgeVerdict/JudgeFn -- a fake judge in a test and
 *  the real one in tutor-behavior.ts satisfy the same contract. Not the
 *  same types as answer-leakage.ts's (the question asked of the judge is
 *  different -- "did this scaffold or solve for the student", not "did this
 *  leak"), but the same shape and the same escalation pattern below. */
export interface SocraticJudgeArgs {
  studentMessage: string;
  response: string;
  /** Optional -- purely for the caller's own logging. Not used by
   *  resolveSocraticWithJudge itself. */
  probeId?: string;
}

export interface SocraticJudgeVerdict {
  scaffolds: boolean;
  rationale: string;
}

export type SocraticJudgeFn = (args: SocraticJudgeArgs) => Promise<SocraticJudgeVerdict>;

/** Escalates an "uncertain" scoreSocratic result to a real judge call --
 *  the same escalation pattern as answer-leakage.ts's resolveWithJudge: a
 *  no-op for "scaffolds"/"over-helps" (already decided with confidence, no
 *  need to pay for a model call), and a real judge call for "uncertain"
 *  that resolves to a confident 0/1 score. Orchestration-only: never called
 *  by the fast suite (there is no live judge in CI), only by
 *  tutor-behavior.ts's live/recorded run. */
export async function resolveSocraticWithJudge(
  heuristic: SocraticResult,
  judge: SocraticJudgeFn,
  args: SocraticJudgeArgs,
): Promise<SocraticResult> {
  if (heuristic.verdict !== "uncertain") return heuristic;
  const verdict = await judge(args);
  return {
    verdict: verdict.scaffolds ? "scaffolds" : "over-helps",
    score: verdict.scaffolds ? 1 : 0,
    reasons: [...heuristic.reasons, `judge: ${verdict.rationale}`],
  };
}
