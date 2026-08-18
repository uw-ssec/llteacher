/* --------------------------------------------------------------------------
   Flattening a stored `messages.parts` array to plain text (#360).

   Written twice, verbatim, when #75 and #91 landed in the same milestone --
   identical implementations with identical comments, which is the state from
   which two copies drift. The consequence would not have been cosmetic: the
   two consumers are a grading model's view of a conversation and an
   instructor's exported record of it, so a change to one that missed the
   other means the transcript an instructor archives and the transcript a
   grader was shown disagree about what the student said.
   -------------------------------------------------------------------------- */

/** Text parts only.
 *
 *  Tool calls and their results are the generative-UI machinery -- definition
 *  cards and the like. They are not the student's reasoning, and feeding
 *  their JSON to a grader spends context on markup while putting internal
 *  representation into an exported record a human is meant to read.
 *
 *  Returns "" for anything that is not a parts array, rather than throwing:
 *  both callers are bulk readers over many rows, and one malformed row must
 *  not fail an export of three hundred conversations. */
export function messageTextOf(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter(
      (p): p is { type: string; text: string } =>
        typeof p === "object" &&
        p !== null &&
        (p as { type?: unknown }).type === "text" &&
        typeof (p as { text?: unknown }).text === "string",
    )
    .map((p) => p.text)
    .join("\n");
}
