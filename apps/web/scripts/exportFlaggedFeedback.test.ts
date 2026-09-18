import { describe, it, expect } from "vitest";
import { extractText, selectPrecedingMessages } from "./exportFlaggedFeedback";

/* --------------------------------------------------------------------------
   Server-hardening audit fix, Minor #5 (Performance+Scalability): unit
   coverage for the batched N+1 replacement in exportFlaggedFeedback.ts.

   selectPrecedingMessages is the actual "batching logic" the finding is
   about -- given the flat, already-fetched set of every user message across
   every touched conversation (what the real findPrecedingStudentMessages
   fetches in ONE query instead of one-per-row), does it correctly pick each
   flagged row's own immediately-preceding message? Deliberately pure (no
   `db`, no network), so this exercises exactly that selection logic without
   a real or mocked database connection -- the script's own manual/offline
   posture (see the module's own doc comment) makes a real-DB
   `.db.test.ts`-style test overkill for what is, at its core, a small
   in-memory grouping function.
   -------------------------------------------------------------------------- */

function textPart(text: string) {
  return [{ type: "text" as const, text }];
}

describe("extractText", () => {
  it("joins text parts with newlines", () => {
    expect(extractText([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb");
  });

  it("ignores non-text parts", () => {
    expect(extractText([{ type: "tool-call", text: "ignored" }, { type: "text", text: "kept" }])).toBe("kept");
  });

  it("returns '' for non-array input", () => {
    expect(extractText(null)).toBe("");
    expect(extractText(undefined)).toBe("");
    expect(extractText("not an array")).toBe("");
  });
});

describe("selectPrecedingMessages (batched N+1 replacement)", () => {
  it("picks the immediately-preceding message per row, from a single shared batch", () => {
    // Two flagged rows in two DIFFERENT conversations -- what used to be
    // two separate `findPrecedingStudentMessage` round trips is now one
    // fetch (simulated here as the pre-fetched `userMessagesByConversationAsc`
    // array) plus this in-memory selection.
    const rows = [
      { id: "flag-1", conversationId: "conv-a", messageSeq: 5 },
      { id: "flag-2", conversationId: "conv-b", messageSeq: 9 },
    ];
    const userMessages = [
      { conversationId: "conv-a", seq: 1, parts: textPart("a-first") },
      { conversationId: "conv-a", seq: 3, parts: textPart("a-second") },
      { conversationId: "conv-b", seq: 2, parts: textPart("b-first") },
      { conversationId: "conv-b", seq: 7, parts: textPart("b-second") },
    ];

    const result = selectPrecedingMessages(rows, userMessages);

    expect(result.get("flag-1")).toBe("a-second");
    expect(result.get("flag-2")).toBe("b-second");
  });

  it("never picks a message at or after the flagged message's own seq", () => {
    const rows = [{ id: "flag-1", conversationId: "conv-a", messageSeq: 3 }];
    const userMessages = [
      { conversationId: "conv-a", seq: 3, parts: textPart("same-seq, must not be picked") },
      { conversationId: "conv-a", seq: 5, parts: textPart("later, must not be picked") },
    ];

    const result = selectPrecedingMessages(rows, userMessages);

    expect(result.get("flag-1")).toBe("");
  });

  it("keys to '' when the conversation has no user message before the flagged seq", () => {
    const rows = [{ id: "flag-1", conversationId: "conv-a", messageSeq: 1 }];
    const result = selectPrecedingMessages(rows, []);
    expect(result.get("flag-1")).toBe("");
  });

  it("does not cross-contaminate between conversations sharing the same seq numbering", () => {
    // conv-a and conv-b both have a message at seq 2 -- the per-conversation
    // grouping must keep them separate rather than one flat seq-ordered list.
    const rows = [
      { id: "flag-1", conversationId: "conv-a", messageSeq: 4 },
      { id: "flag-2", conversationId: "conv-b", messageSeq: 4 },
    ];
    const userMessages = [
      { conversationId: "conv-a", seq: 2, parts: textPart("a-only") },
      { conversationId: "conv-b", seq: 2, parts: textPart("b-only") },
    ];

    const result = selectPrecedingMessages(rows, userMessages);

    expect(result.get("flag-1")).toBe("a-only");
    expect(result.get("flag-2")).toBe("b-only");
  });

  it("handles multiple flagged rows in the same conversation independently", () => {
    const rows = [
      { id: "flag-early", conversationId: "conv-a", messageSeq: 4 },
      { id: "flag-late", conversationId: "conv-a", messageSeq: 8 },
    ];
    const userMessages = [
      { conversationId: "conv-a", seq: 1, parts: textPart("m1") },
      { conversationId: "conv-a", seq: 3, parts: textPart("m3") },
      { conversationId: "conv-a", seq: 6, parts: textPart("m6") },
    ];

    const result = selectPrecedingMessages(rows, userMessages);

    expect(result.get("flag-early")).toBe("m3");
    expect(result.get("flag-late")).toBe("m6");
  });
});
