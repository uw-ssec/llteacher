/* --------------------------------------------------------------------------
   #36: validating and normalising a student's knowledge-check answer.

   The answer arrives as an ordinary user message carrying a
   `data-knowledge-check-response` part. Nothing in it is taken on trust:
   the referenced check must be a `tool-knowledgeCheck` call that the
   SERVER produced in this conversation's recent history, unanswered so
   far, and the chosen index must be one of its options. The stored message
   is then REBUILT from that persisted call -- the question, the options,
   the chosen option's text, and the canonical sentence the model reads --
   so a client can't misreport what was asked or what it picked.
   -------------------------------------------------------------------------- */

import {
  KNOWLEDGE_CHECK_PART_TYPE,
  KNOWLEDGE_CHECK_TOOL,
  collectKnowledgeCheckAnswers,
  knowledgeCheckAnswerText,
  type KnowledgeCheckResponse,
} from "@llteacher/ui/generative/knowledgeCheck";

type Part = { type: string } & Record<string, unknown>;
type HistoryRow = { role: string; parts: unknown };

export type KnowledgeCheckAnswerResult =
  | { kind: "not-an-answer" }
  | { kind: "answer"; parts: Part[]; response: KnowledgeCheckResponse }
  | { kind: "invalid"; message: string };

function findCheck(history: readonly HistoryRow[], toolCallId: string): { question: string; options: string[] } | null {
  for (const row of history) {
    if (row.role !== "assistant" || !Array.isArray(row.parts)) continue;
    for (const part of row.parts as Part[]) {
      if (part.type !== `tool-${KNOWLEDGE_CHECK_TOOL}` || part.toolCallId !== toolCallId) continue;
      const input = part.input as { question?: unknown; options?: unknown } | undefined;
      if (typeof input?.question === "string" && Array.isArray(input.options) && input.options.every((o) => typeof o === "string")) {
        return { question: input.question, options: input.options as string[] };
      }
    }
  }
  return null;
}

/** `parts` is the inbound message's parts; `history` the conversation's
 *  persisted recent messages (any order). */
export function normalizeKnowledgeCheckAnswer(parts: readonly Part[], history: readonly HistoryRow[]): KnowledgeCheckAnswerResult {
  const responses = parts.filter((p) => p.type === KNOWLEDGE_CHECK_PART_TYPE);
  if (responses.length === 0) return { kind: "not-an-answer" };
  if (responses.length > 1) return { kind: "invalid", message: "Answer one knowledge check at a time." };

  const data = (responses[0]!.data ?? {}) as { toolCallId?: unknown; selectedIndex?: unknown };
  if (typeof data.toolCallId !== "string" || data.toolCallId.length === 0 || data.toolCallId.length > 200) {
    return { kind: "invalid", message: "That answer doesn't name a knowledge check." };
  }
  const check = findCheck(history, data.toolCallId);
  if (!check) return { kind: "invalid", message: "That knowledge check isn't part of this conversation." };
  if (typeof data.selectedIndex !== "number" || !Number.isInteger(data.selectedIndex) || data.selectedIndex < 0 || data.selectedIndex >= check.options.length) {
    return { kind: "invalid", message: "Choose one of the knowledge check's options." };
  }
  if (collectKnowledgeCheckAnswers(history as Array<{ role: string; parts: unknown[] }>).has(data.toolCallId)) {
    return { kind: "invalid", message: "That knowledge check has already been answered." };
  }

  const response: KnowledgeCheckResponse = {
    toolCallId: data.toolCallId,
    question: check.question,
    options: check.options,
    selectedIndex: data.selectedIndex,
    selectedOption: check.options[data.selectedIndex]!,
  };
  return {
    kind: "answer",
    response,
    parts: [
      { type: "text", text: knowledgeCheckAnswerText(check.question, check.options, data.selectedIndex) },
      { type: KNOWLEDGE_CHECK_PART_TYPE, data: response },
    ],
  };
}
