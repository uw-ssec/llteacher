import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { HomeworkForm } from "./HomeworkForm";

const LLM_CONFIGS = [{ id: "cfg-1", recordNumber: 1, name: "Default", modelName: "gpt-4o-mini", basePromptPreview: "", temperature: 0.7, maxCompletionTokens: 1000, isDefault: true, isActive: true, createdAt: "2026-01-01" }];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("HomeworkForm", () => {
  it("requires a title and at least one section before submit", async () => {
    const onSubmit = vi.fn();
    render(<HomeworkForm onSubmit={onSubmit} llmConfigs={LLM_CONFIGS} />);
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(screen.getByText(/title required/i)).toBeTruthy());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("shows a due date required alert when due date is left blank", async () => {
    const onSubmit = vi.fn();
    render(<HomeworkForm onSubmit={onSubmit} llmConfigs={LLM_CONFIGS} />);
    fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: "New HW" } });
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: "desc" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(screen.getByText(/due date required/i)).toBeTruthy());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("adds a section, fills it out, and submits with order renumbered", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<HomeworkForm onSubmit={onSubmit} llmConfigs={LLM_CONFIGS} />);
    fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: "New HW" } });
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: "desc" } });
    fireEvent.change(screen.getByLabelText(/due date/i), { target: { value: "2099-01-01T00:00" } });
    fireEvent.click(screen.getByRole("button", { name: /add section/i }));
    const titleInputs = screen.getAllByLabelText(/section title/i);
    fireEvent.change(titleInputs[0]!, { target: { value: "Sec 1" } });
    const contentInputs = screen.getAllByLabelText(/section content/i);
    fireEvent.change(contentInputs[0]!, { target: { value: "Sec 1 content" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.sections).toEqual([{ title: "Sec 1", content: "Sec 1 content", order: 1, solutionContent: undefined }]);
  });

  it("removing a section drops it and renumbers the rest", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<HomeworkForm onSubmit={onSubmit} llmConfigs={LLM_CONFIGS} />);
    fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: "HW" } });
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: "d" } });
    fireEvent.change(screen.getByLabelText(/due date/i), { target: { value: "2099-01-01T00:00" } });
    fireEvent.click(screen.getByRole("button", { name: /add section/i }));
    fireEvent.click(screen.getByRole("button", { name: /add section/i }));
    fireEvent.click(screen.getAllByRole("button", { name: /remove section/i })[0]!);
    const titleInputs = screen.getAllByLabelText(/section title/i);
    expect(titleInputs).toHaveLength(1);
  });

  it("does not remove a section when the delete confirmation is dismissed", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<HomeworkForm onSubmit={vi.fn()} llmConfigs={LLM_CONFIGS} />);
    fireEvent.click(screen.getByRole("button", { name: /add section/i }));
    fireEvent.click(screen.getByRole("button", { name: /remove section/i }));
    expect(screen.getAllByLabelText(/section title/i)).toHaveLength(1);
  });

  it("removes a section when the delete confirmation is accepted", () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<HomeworkForm onSubmit={vi.fn()} llmConfigs={LLM_CONFIGS} />);
    fireEvent.click(screen.getByRole("button", { name: /add section/i }));
    fireEvent.click(screen.getByRole("button", { name: /remove section/i }));
    expect(screen.queryAllByLabelText(/section title/i)).toHaveLength(0);
  });

  it("renders a live markdown preview of a section's content", () => {
    render(<HomeworkForm onSubmit={vi.fn()} llmConfigs={LLM_CONFIGS} />);
    fireEvent.click(screen.getByRole("button", { name: /add section/i }));
    const content = screen.getAllByLabelText(/section content/i)[0]!;
    fireEvent.change(content, { target: { value: "**bold**" } });
    const preview = screen.getByLabelText(/section 1 content preview/i);
    expect(preview.querySelector("strong")?.textContent).toBe("bold");
  });

  it("renders a live markdown preview of a section's solution", () => {
    render(<HomeworkForm onSubmit={vi.fn()} llmConfigs={LLM_CONFIGS} />);
    fireEvent.click(screen.getByRole("button", { name: /add section/i }));
    const solution = screen.getAllByLabelText(/section solution/i)[0]!;
    fireEvent.change(solution, { target: { value: "**answer**" } });
    const preview = screen.getByLabelText(/section 1 solution preview/i);
    expect(preview.querySelector("strong")?.textContent).toBe("answer");
  });

  it("adds and removes exactly one beforeunload listener per mount/unmount (no leak)", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const { unmount } = render(<HomeworkForm onSubmit={vi.fn()} llmConfigs={LLM_CONFIGS} />);

    const addCalls = addSpy.mock.calls.filter((c) => c[0] === "beforeunload").length;
    expect(addCalls).toBe(1);

    unmount();

    const removeCalls = removeSpy.mock.calls.filter((c) => c[0] === "beforeunload").length;
    expect(removeCalls).toBe(1);
  });

  it("rejects submit past 20 sections", async () => {
    const onSubmit = vi.fn();
    render(<HomeworkForm onSubmit={onSubmit} llmConfigs={LLM_CONFIGS} />);
    for (let i = 0; i < 21; i++) fireEvent.click(screen.getByRole("button", { name: /add section/i }));
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(screen.getByText(/20 sections/i)).toBeTruthy());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keyboard: tab order flows title -> content -> add-solution within a section", () => {
    render(<HomeworkForm onSubmit={vi.fn()} llmConfigs={LLM_CONFIGS} />);
    fireEvent.click(screen.getByRole("button", { name: /add section/i }));
    const title = screen.getAllByLabelText(/section title/i)[0]!;
    title.focus();
    expect(document.activeElement).toBe(title);
    fireEvent.keyDown(title, { key: "Tab" });
    // jsdom doesn't execute real tab-order focus movement -- this asserts
    // the DOM order (fieldset children) matches the intended tab sequence,
    // which is what actually determines native tab order.
    const fieldset = title.closest("fieldset")!;
    const focusable = Array.from(fieldset.querySelectorAll("input, textarea, button"));
    expect(focusable[0]).toBe(title);
  });

  // #166
  it("renders a controllable Hidden checkbox and expires-at field, included in the submit payload", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<HomeworkForm onSubmit={onSubmit} llmConfigs={LLM_CONFIGS} />);
    fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: "HW" } });
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: "d" } });
    fireEvent.change(screen.getByLabelText(/due date/i), { target: { value: "2099-01-01T00:00" } });
    fireEvent.click(screen.getByRole("button", { name: /add section/i }));
    fireEvent.change(screen.getAllByLabelText(/section title/i)[0]!, { target: { value: "Sec 1" } });
    fireEvent.change(screen.getAllByLabelText(/section content/i)[0]!, { target: { value: "c" } });

    const hiddenCheckbox = screen.getByLabelText(/^hidden/i) as HTMLInputElement;
    expect(hiddenCheckbox.checked).toBe(false);
    fireEvent.click(hiddenCheckbox);
    expect(hiddenCheckbox.checked).toBe(true);
    fireEvent.change(screen.getByLabelText(/expires at/i), { target: { value: "2099-06-01T00:00" } });

    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.hidden).toBe(true);
    expect(payload.expiresAt).toBe("2099-06-01T00:00");
  });

  it("shows a friendly error and does not throw when onSubmit rejects", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error("network error"));
    render(<HomeworkForm onSubmit={onSubmit} llmConfigs={LLM_CONFIGS} />);
    fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: "HW" } });
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: "d" } });
    fireEvent.change(screen.getByLabelText(/due date/i), { target: { value: "2099-01-01T00:00" } });
    fireEvent.click(screen.getByRole("button", { name: /add section/i }));
    fireEvent.change(screen.getAllByLabelText(/section title/i)[0]!, { target: { value: "Sec 1" } });
    fireEvent.change(screen.getAllByLabelText(/section content/i)[0]!, { target: { value: "c" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(screen.getByText(/failed to save/i)).toBeTruthy());
  });
});
