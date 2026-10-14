// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { renderToolPart, type ToolPart } from "./render";
import { collectKnowledgeCheckAnswers } from "./knowledgeCheck";

afterEach(cleanup);

const input = { question: "Which shifts aggregate demand left?", options: ["A fall in consumer confidence", "A rise in productivity", "Lower oil prices"] };
const part = (over: Partial<ToolPart> = {}): ToolPart => ({ type: "tool-knowledgeCheck", state: "output-available", toolCallId: "call_1", input, ...over });

describe("KnowledgeCheck (#36)", () => {
  it("is a radio group with Submit disabled until an option is chosen, then sends that option", async () => {
    const onAnswer = vi.fn(async () => {});
    render(<>{renderToolPart(part(), "k", { knowledgeCheck: { answers: new Map(), onAnswer } })}</>);
    const submit = screen.getByRole("button", { name: "Submit answer" }) as HTMLButtonElement;
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Option A: A fall in consumer confidence" }));
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("call_1", input.question, input.options, 0));
  });

  it("is locked on the stored answer, with no Submit, once answered (including on replay)", () => {
    render(<>{renderToolPart(part(), "k", { knowledgeCheck: { answers: new Map([["call_1", 2]]), onAnswer: vi.fn() } })}</>);
    expect(screen.queryByRole("button", { name: "Submit answer" })).toBeNull();
    expect((screen.getByRole("radio", { name: /Option C/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getAllByRole("radio").every((r) => r.matches(":disabled"))).toBe(true);
    expect(screen.getByText(/You chose C/)).toBeTruthy();
  });

  it("is read-only where no answer can be sent (e.g. an instructor's transcript view)", () => {
    render(<>{renderToolPart(part(), "k")}</>);
    expect(screen.queryByRole("button", { name: "Submit answer" })).toBeNull();
    expect(screen.getAllByRole("radio").every((r) => r.matches(":disabled"))).toBe(true);
  });

  it("tells the student when the answer didn't send, and lets them try again", async () => {
    const onAnswer = vi.fn(async () => { throw new Error("busy"); });
    render(<>{renderToolPart(part(), "k", { knowledgeCheck: { answers: new Map(), onAnswer } })}</>);
    fireEvent.click(screen.getByRole("radio", { name: /Option B/ }));
    fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/didn't send/);
    expect((screen.getByRole("button", { name: "Submit answer" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("never renders an answer key the model might have smuggled into its input", () => {
    render(<>{renderToolPart(part({ input: { ...input, correctIndex: 0, answer: "A fall in consumer confidence is correct" } }), "k")}</>);
    expect(document.body.textContent).not.toMatch(/correct/i);
  });

  it.each([
    ["one option", { question: "q", options: ["only"] }],
    ["duplicate options", { question: "q", options: ["Yes", "yes"] }],
    ["seven options", { question: "q", options: ["a", "b", "c", "d", "e", "f", "g"] }],
    ["an empty question", { question: " ", options: ["a", "b"] }],
  ])("renders nothing for %s", (_l, bad) => {
    const { container } = render(<>{renderToolPart(part({ input: bad }), "k")}</>);
    expect(container.innerHTML).toBe("");
  });
});

describe("collectKnowledgeCheckAnswers", () => {
  it("reads the first answer per check from user messages only", () => {
    const answers = collectKnowledgeCheckAnswers([
      { role: "assistant", parts: [{ type: "data-knowledge-check-response", data: { toolCallId: "x", selectedIndex: 9 } }] },
      { role: "user", parts: [{ type: "text", text: "B" }, { type: "data-knowledge-check-response", data: { toolCallId: "c1", selectedIndex: 1 } }] },
      { role: "user", parts: [{ type: "data-knowledge-check-response", data: { toolCallId: "c1", selectedIndex: 2 } }] },
    ]);
    expect([...answers]).toEqual([["c1", 1]]);
  });
});
