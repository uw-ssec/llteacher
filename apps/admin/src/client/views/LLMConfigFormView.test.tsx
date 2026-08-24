import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { LLMConfigFormView } from "./LLMConfigFormView";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const noop = async () => {};

/** Drives the real change event a file picker would fire. `userEvent.upload`
 *  would also work, but going through the input directly keeps the
 *  same-file-twice case below testable -- that one depends on the handler
 *  clearing `input.value`, which a helper would hide. */
function pickFile(input: HTMLInputElement, name: string, body: string, type = "text/markdown") {
  const file = new File([body], name, { type });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  fireEvent.change(input);
}

function renderForm() {
  render(<LLMConfigFormView onSave={noop} onCancel={() => {}} />);
  return {
    input: screen.getByLabelText(/import \.md/i) as HTMLInputElement,
    textarea: screen.getByLabelText(/^base prompt$/i) as HTMLTextAreaElement,
  };
}

describe("LLMConfigFormView — importing a base prompt", () => {
  it("loads a markdown file into the base prompt field", async () => {
    const { input, textarea } = renderForm();
    pickFile(input, "tutor.md", "# Tutor\n\nBe **Socratic**.");
    await waitFor(() => expect(textarea.value).toBe("# Tutor\n\nBe **Socratic**."));
    expect(screen.getByRole("alert").textContent).toMatch(/loaded tutor\.md/i);
  });

  // The `accept` attribute is only a picker hint -- every OS lets you defeat
  // it with "All Files" -- so the extension has to be re-checked in code.
  it("rejects a non-markdown file even though accept would have filtered it", async () => {
    const { input, textarea } = renderForm();
    pickFile(input, "prompt.txt", "# Tutor", "text/plain");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/isn't a markdown file/i));
    expect(textarea.value).toBe("");
  });

  it("rejects a file past the size cap rather than pasting it into the textarea", async () => {
    const { input, textarea } = renderForm();
    pickFile(input, "huge.md", "x".repeat(200 * 1024));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/limit is 128 KB/i));
    expect(textarea.value).toBe("");
  });

  it("rejects an empty file instead of silently blanking the field", async () => {
    const { input, textarea } = renderForm();
    pickFile(input, "first.md", "# Real content");
    await waitFor(() => expect(textarea.value).toBe("# Real content"));

    vi.spyOn(window, "confirm").mockReturnValue(true);
    pickFile(input, "blank.md", "   \n  ");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/is empty/i));
    expect(textarea.value).toBe("# Real content");
  });

  it("does not confirm when the field is empty — there is nothing to lose", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { input, textarea } = renderForm();
    pickFile(input, "tutor.md", "# Tutor");
    await waitFor(() => expect(textarea.value).toBe("# Tutor"));
    expect(confirm).not.toHaveBeenCalled();
  });

  it("keeps the existing prompt when the replace confirmation is declined", async () => {
    const { input, textarea } = renderForm();
    fireEvent.change(textarea, { target: { value: "hand-written prompt" } });

    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    pickFile(input, "replacement.md", "# Replacement");

    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(textarea.value).toBe("hand-written prompt");
  });

  it("replaces the existing prompt when the confirmation is accepted", async () => {
    const { input, textarea } = renderForm();
    fireEvent.change(textarea, { target: { value: "hand-written prompt" } });

    vi.spyOn(window, "confirm").mockReturnValue(true);
    pickFile(input, "replacement.md", "# Replacement");
    await waitFor(() => expect(textarea.value).toBe("# Replacement"));
  });

  // NOTE: the handler also resets `input.value` after every pick, because a
  // real file input fires no change event when the same path is chosen twice
  // -- so editing a file externally and re-importing it would silently do
  // nothing. That reset is NOT asserted here and cannot be: a file input's
  // value may only ever be assigned "", so the dirty precondition the reset
  // exists to clear is unconstructable in jsdom, and any assertion would pass
  // whether or not the reset were there (confirmed by mutation). It is
  // verified in a real browser instead. What this test does cover is the
  // weaker but still useful property that a second import of the same
  // filename replaces the first.
  it("imports again when the same filename is picked a second time", async () => {
    const { input, textarea } = renderForm();
    pickFile(input, "tutor.md", "# First");
    await waitFor(() => expect(textarea.value).toBe("# First"));

    vi.spyOn(window, "confirm").mockReturnValue(true);
    pickFile(input, "tutor.md", "# Edited externally");
    await waitFor(() => expect(textarea.value).toBe("# Edited externally"));
  });
});
