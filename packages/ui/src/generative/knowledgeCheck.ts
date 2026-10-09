/** #36: the knowledge check's response contract, shared by the client (which
 *  sends an answer) and the server (which validates and stores it). Plain
 *  TypeScript, no React, same pattern as renderableTools.ts.
 *
 *  An answer travels as an ordinary user message with two parts:
 *    - a text part, the canonical sentence the MODEL reads on its next turn
 *      ("Answer to …: B. …") -- data parts never reach the model;
 *    - a `data-knowledge-check-response` part, the structured record the
 *      transcript keeps (for locking the check on replay, and for M8's
 *      per-section check analytics).
 *  The server rebuilds both from the knowledge check it finds in the
 *  conversation's own history, so a client can't misreport what was asked
 *  or which option it picked. There is deliberately no answer key anywhere
 *  in the tool input: the model judges the answer on the next turn, so
 *  nothing in the browser can reveal it early. */

export const KNOWLEDGE_CHECK_TOOL = "knowledgeCheck";
export const KNOWLEDGE_CHECK_PART_TYPE = "data-knowledge-check-response";
export const KNOWLEDGE_CHECK_MIN_OPTIONS = 2;
export const KNOWLEDGE_CHECK_MAX_OPTIONS = 6;

export interface KnowledgeCheckResponse {
  toolCallId: string;
  question: string;
  options: string[];
  selectedIndex: number;
  selectedOption: string;
}

export function optionLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

/** The sentence the model reads: the question, the letter and the option. */
export function knowledgeCheckAnswerText(question: string, options: readonly string[], selectedIndex: number): string {
  return `My answer to the check "${question}": ${optionLetter(selectedIndex)}. ${options[selectedIndex]}`;
}

/** toolCallId -> selectedIndex for every answer already in a transcript.
 *  Reads parts structurally; anything malformed is skipped. */
export function collectKnowledgeCheckAnswers(
  messages: ReadonlyArray<{ role: string; parts: ReadonlyArray<unknown> }>,
): Map<string, number> {
  const answers = new Map<string, number>();
  for (const m of messages) {
    if (m.role !== "user") continue;
    for (const part of m.parts) {
      const p = part as { type?: unknown; data?: { toolCallId?: unknown; selectedIndex?: unknown } };
      if (p.type !== KNOWLEDGE_CHECK_PART_TYPE) continue;
      const id = p.data?.toolCallId;
      const idx = p.data?.selectedIndex;
      if (typeof id === "string" && typeof idx === "number" && !answers.has(id)) answers.set(id, idx);
    }
  }
  return answers;
}
