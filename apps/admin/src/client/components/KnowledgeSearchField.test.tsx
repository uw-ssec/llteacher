// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent, act } from "@testing-library/react";
import { KnowledgeSearchField } from "./KnowledgeSearchField";

afterEach(() => { cleanup(); vi.useRealTimers(); });

function renderField(over: Partial<React.ComponentProps<typeof KnowledgeSearchField>> = {}) {
  const props = {
    value: "", onChange: vi.fn(), onSubmit: vi.fn(), onClear: vi.fn(),
    scope: null, onClearScope: vi.fn(), busy: false, ...over,
  };
  render(<KnowledgeSearchField {...props} />);
  return props;
}

describe("KnowledgeSearchField", () => {
  it("reports typing and submits on Enter", () => {
    const { onChange, onSubmit } = renderField({ value: "problem" });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "problem set" } });
    expect(onChange).toHaveBeenCalledWith("problem set");
    fireEvent.submit(screen.getByRole("search"));
    expect(onSubmit).toHaveBeenCalled();
  });

  it("submits from the icon button inside the field", () => {
    const { onSubmit } = renderField({ value: "problem" });
    fireEvent.click(screen.getByRole("button", { name: "Search inside documents" }));
    expect(onSubmit).toHaveBeenCalled();
  });

  it("shows a clear button only when there is text, and clears on Esc", () => {
    renderField({ value: "" });
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
    cleanup();
    const { onClear } = renderField({ value: "gdp" });
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(onClear).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });
    expect(onClear).toHaveBeenCalledTimes(2);
  });

  it("shows the folder scope as a chip that can be removed", () => {
    const { onClearScope } = renderField({ scope: "week1/problem-sets" });
    expect(screen.getByText("problem-sets")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear folder scope" }));
    expect(onClearScope).toHaveBeenCalled();
  });

  it("runs the content search after a pause once three characters are typed", () => {
    vi.useFakeTimers();
    const { onSubmit, rerender } = (() => {
      const props = { value: "", onChange: vi.fn(), onSubmit: vi.fn(), onClear: vi.fn(), scope: null, onClearScope: vi.fn(), busy: false };
      const r = render(<KnowledgeSearchField {...props} />);
      return { ...props, rerender: (value: string) => r.rerender(<KnowledgeSearchField {...props} value={value} />) };
    })();
    rerender("gd");
    act(() => { vi.advanceTimersByTime(600); });
    expect(onSubmit).not.toHaveBeenCalled();
    rerender("gdp");
    act(() => { vi.advanceTimersByTime(300); });
    expect(onSubmit).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(200); });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
