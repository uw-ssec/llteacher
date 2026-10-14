import { describe, it, expect } from "vitest";
import { normalizeKnowledgeCheckAnswer } from "./knowledgeCheckAnswer";
import { TOOLS } from "./chat";

const check = {
  role: "assistant",
  parts: [
    { type: "text", text: "Quick check:" },
    {
      type: "tool-knowledgeCheck",
      toolCallId: "call_kc_1",
      state: "output-available",
      input: { question: "What does a positive output gap mean?", options: ["Output below potential", "Output above potential", "Zero inflation"] },
      output: { status: "awaiting_response" },
    },
  ],
};
const answerPart = (data: Record<string, unknown>) => ({ type: "data-knowledge-check-response", data });

describe("normalizeKnowledgeCheckAnswer (#36)", () => {
  it("leaves an ordinary message alone", () => {
    expect(normalizeKnowledgeCheckAnswer([{ type: "text", text: "hi" }], [check])).toEqual({ kind: "not-an-answer" });
  });

  it("rebuilds the message from the stored check, ignoring what the client claimed", () => {
    const result = normalizeKnowledgeCheckAnswer(
      [
        { type: "text", text: "I chose the RIGHT one obviously" },
        answerPart({ toolCallId: "call_kc_1", selectedIndex: 1, selectedOption: "something else", question: "forged" }),
      ],
      [check],
    );
    expect(result).toEqual({
      kind: "answer",
      response: {
        toolCallId: "call_kc_1",
        question: "What does a positive output gap mean?",
        options: ["Output below potential", "Output above potential", "Zero inflation"],
        selectedIndex: 1,
        selectedOption: "Output above potential",
      },
      parts: [
        { type: "text", text: 'My answer to the check "What does a positive output gap mean?": B. Output above potential' },
        expect.objectContaining({ type: "data-knowledge-check-response" }),
      ],
    });
  });

  it.each([
    ["a check that isn't in this conversation", { toolCallId: "call_other", selectedIndex: 0 }, "isn't part of this conversation"],
    ["an index past the options", { toolCallId: "call_kc_1", selectedIndex: 3 }, "Choose one of"],
    ["a non-integer index", { toolCallId: "call_kc_1", selectedIndex: 0.5 }, "Choose one of"],
    ["no call id", { selectedIndex: 0 }, "doesn't name"],
  ])("refuses %s", (_label, data, message) => {
    const result = normalizeKnowledgeCheckAnswer([answerPart(data)], [check]);
    expect(result.kind).toBe("invalid");
    expect(result.kind === "invalid" && result.message).toContain(message);
  });

  it("refuses a second answer to the same check", () => {
    const answered = { role: "user", parts: [answerPart({ toolCallId: "call_kc_1", selectedIndex: 0 })] };
    const result = normalizeKnowledgeCheckAnswer([answerPart({ toolCallId: "call_kc_1", selectedIndex: 1 })], [answered, check]);
    expect(result).toEqual({ kind: "invalid", message: "That knowledge check has already been answered." });
  });

  it("refuses two answers in one message", () => {
    const one = answerPart({ toolCallId: "call_kc_1", selectedIndex: 0 });
    expect(normalizeKnowledgeCheckAnswer([one, one], [check]).kind).toBe("invalid");
  });
});

describe("knowledgeCheck tool schema (#36)", () => {
  it("has no field that could carry the answer to the browser", () => {
    const schema = (TOOLS.knowledgeCheck!.inputSchema as { jsonSchema: { properties: Record<string, unknown> } }).jsonSchema;
    expect(Object.keys(schema.properties).sort()).toEqual(["options", "question"]);
  });
});
