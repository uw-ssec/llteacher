/* --------------------------------------------------------------------------
   AI-assisted grade drafts (#75).

   The platform plan calls conversation-quality grading "Sara's pattern" and
   names it the cross-runtime evaluation surface worth preserving: what is
   being assessed is how the student reasoned in the transcript, not whether
   a final answer matches.

   TWO RULES SHAPE EVERYTHING HERE.

   1. THE DRAFT IS NEVER THE GRADE. This function returns a proposal. The
      caller stores it as `graded_by_ai = true`, which the schema and
      repositories/grades.ts treat as inert by construction -- a grade is in
      force only when a human wrote their own row. Nothing here needs an
      "approved" flag, because there is no state in which this output counts.

   2. THE SOLUTION NEVER LEAVES. The model is given the section's model
      solution so it can judge the student's reasoning against it -- that is
      the whole point of an assisted draft. What comes BACK is parsed into
      exactly two fields, a number and a rationale, and the rationale is
      screened before it is stored. A model that quotes the answer key into
      its rationale would otherwise put the solution in front of any student
      who is later shown their feedback. `redactSolutionEcho` is what stops
      that, and it fails CLOSED: when it cannot tell, it withholds.
   -------------------------------------------------------------------------- */

import { generateText } from "ai";
import { getOpenRouter } from "../ai";
import { logServerError } from "../../server/utils/errors";

export interface DraftInput {
  /** The section's prompt, as the student saw it. */
  sectionContent: string;
  /** The model solution. Instructor-only: given TO the model, never
   *  returned. Absent when the author has not written one, in which case the
   *  draft judges the reasoning on its own terms. */
  solutionContent: string | null;
  /** The student's side of the conversation, oldest first. */
  transcript: { role: string; text: string }[];
  maxScore: number;
  modelName: string;
  apiKey: string;
  signal?: AbortSignal;
}

export interface DraftOutput {
  score: number | null;
  maxScore: number;
  rationale: string;
  modelName: string;
}

const TRANSCRIPT_CHAR_BUDGET = 24_000;

/** The system prompt. Written to produce a JSON object because a draft that
 *  cannot be parsed is worse than no draft -- an instructor would have to
 *  read prose to find a number, which is the work the draft was meant to
 *  save. */
function systemPrompt(maxScore: number, hasSolution: boolean): string {
  return [
    "You are assisting a university instructor by drafting a grade for one student's tutoring conversation.",
    "You are assessing the QUALITY OF THE STUDENT'S REASONING as it developed across the conversation: whether they engaged with the questions, revised their thinking, and reached understanding. You are not checking whether a final answer string matches.",
    hasSolution
      ? "You are given the instructor's model solution as a reference for what understanding looks like. NEVER quote, paraphrase, restate or reveal any part of the model solution in your rationale. The rationale may be shown to the student."
      : "No model solution was provided. Judge the reasoning on its own terms.",
    `Reply with ONLY a JSON object: {"score": <number between 0 and ${maxScore}>, "rationale": "<2-4 sentences addressed to the instructor>"}.`,
    "If the conversation contains too little student work to judge, use null for score and say so in the rationale.",
  ].join("\n\n");
}

/** Screens a rationale for echoes of the model solution.
 *
 *  Deliberately crude, and deliberately fail-closed. It compares normalized
 *  word sequences: any run of 8+ consecutive words shared with the solution
 *  is treated as a quote. Eight is long enough that ordinary shared
 *  vocabulary ("the standard error of the sample mean is") does not trip it
 *  and short enough to catch a sentence lifted whole.
 *
 *  This cannot be exhaustive -- a model that paraphrases the answer key
 *  defeats any string comparison. That is why it is the SECOND line of
 *  defence and not the first: the prompt instructs against it, this catches
 *  the literal case, and the structural answer is that a draft is never
 *  shown to a student at all unless an instructor approves it into their own
 *  grade, at which point a human has read the sentence. */
export function redactSolutionEcho(rationale: string, solution: string | null): string {
  if (!solution) return rationale;
  const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const solutionWords = words(solution);
  if (solutionWords.length < 8) return rationale;

  const shingles = new Set<string>();
  for (let i = 0; i + 8 <= solutionWords.length; i += 1) {
    shingles.add(solutionWords.slice(i, i + 8).join(" "));
  }

  const rationaleWords = words(rationale);
  for (let i = 0; i + 8 <= rationaleWords.length; i += 1) {
    if (shingles.has(rationaleWords.slice(i, i + 8).join(" "))) {
      return "This draft was withheld because it repeated part of the model solution. Grade this submission directly.";
    }
  }
  return rationale;
}

/** Parses the model's reply. Returns null when it is not usable -- the
 *  caller reports "no draft" rather than inventing a score, because a
 *  fabricated number on a grading screen is the worst possible failure mode
 *  for this feature. */
export function parseDraftReply(raw: string, maxScore: number): { score: number | null; rationale: string } | null {
  // Models wrap JSON in prose or fences however they were asked not to;
  // the outermost brace pair is the reliable extraction.
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as { score?: unknown; rationale?: unknown };

  const rationale = typeof obj.rationale === "string" ? obj.rationale.trim() : "";
  if (!rationale) return null;

  if (obj.score === null || obj.score === undefined) return { score: null, rationale };
  const score = typeof obj.score === "number" ? obj.score : Number(obj.score);
  // Out of range is treated as no score rather than clamped: a model that
  // returned 150 out of 100 has misunderstood the task, and silently making
  // that a 100 would present a confident wrong number to an instructor.
  if (!Number.isFinite(score) || score < 0 || score > maxScore) return { score: null, rationale };
  return { score, rationale };
}

/** Produces a draft, or null when one cannot be produced. Never throws for a
 *  model-side failure: "no draft is available" is an ordinary outcome of a
 *  button whose whole purpose is optional assistance. */
export async function draftGrade(input: DraftInput): Promise<DraftOutput | null> {
  // Oldest-first, trimmed from the FRONT when over budget: the end of a
  // tutoring conversation is where the student's understanding actually
  // lands, so the tail is the part worth keeping.
  let transcript = input.transcript
    .map((m) => `${m.role === "user" ? "STUDENT" : "TUTOR"}: ${m.text}`)
    .join("\n\n");
  if (transcript.length > TRANSCRIPT_CHAR_BUDGET) {
    transcript = `…(earlier turns omitted)…\n\n${transcript.slice(-TRANSCRIPT_CHAR_BUDGET)}`;
  }

  const userContent = [
    `SECTION PROMPT:\n${input.sectionContent}`,
    input.solutionContent ? `MODEL SOLUTION (instructor-only, never repeat):\n${input.solutionContent}` : null,
    `CONVERSATION:\n${transcript}`,
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");

  try {
    const result = await generateText({
      model: getOpenRouter(input.apiKey)(input.modelName),
      system: systemPrompt(input.maxScore, input.solutionContent !== null),
      messages: [{ role: "user", content: userContent }],
      // Low, because this is an assessment: two instructors pressing the
      // button on the same submission should not get materially different
      // numbers.
      temperature: 0.2,
      maxOutputTokens: 600,
      abortSignal: input.signal,
    });

    const parsed = parseDraftReply(result.text, input.maxScore);
    if (!parsed) {
      logServerError("draftGrade", new Error("model reply was not a usable draft"));
      return null;
    }
    return {
      score: parsed.score,
      maxScore: input.maxScore,
      rationale: redactSolutionEcho(parsed.rationale, input.solutionContent),
      modelName: input.modelName,
    };
  } catch (err) {
    // The provider's own message is logged, never surfaced: it can carry
    // request urls, org identifiers and key prefixes.
    logServerError("draftGrade", err);
    return null;
  }
}
