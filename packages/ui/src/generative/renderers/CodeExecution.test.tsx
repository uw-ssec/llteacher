// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { CodeExecution, renderTextWithCode, type RCodeResult } from "./CodeExecution";

afterEach(cleanup);

const SUCCESS_RESULT: RCodeResult = { status: "success", output: "[1] 47", executionTimeMs: 12 };
const ERROR_RESULT: RCodeResult = { status: "error", error: "object 'x' not found", executionTimeMs: 5 };

describe("CodeExecution", () => {
  it("renders the code, no output slot, before any run", () => {
    render(<CodeExecution code="sum(1:10)" />);
    expect(screen.getByText("sum(1:10)")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders only the code (no Run button) when isPartial", () => {
    render(<CodeExecution code="sum(1:1" isPartial onRun={vi.fn()} />);
    expect(screen.getByText("sum(1:1")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows a disabled, explanatory state instead of a Run button when onRun is not provided (graceful degradation)", () => {
    render(<CodeExecution code="1 + 1" />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/isn.t available here/i)).toBeTruthy();
  });

  it("runs the code on click and renders success output in the CodeBlock output slot", async () => {
    const onRun = vi.fn().mockResolvedValue(SUCCESS_RESULT);
    render(<CodeExecution code="sum(1:10)" onRun={onRun} />);

    fireEvent.click(screen.getByRole("button", { name: /run/i }));
    expect(onRun).toHaveBeenCalledWith("sum(1:10)");
    // Button reflects the in-flight state.
    expect(screen.getByRole("button").textContent).toMatch(/running/i);

    await waitFor(() => expect(screen.getByText("[1] 47")).toBeTruthy());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders an R error distinctly from a success output (not via CodeBlock's output slot)", async () => {
    const onRun = vi.fn().mockResolvedValue(ERROR_RESULT);
    render(<CodeExecution code="x + 1" onRun={onRun} />);

    fireEvent.click(screen.getByRole("button", { name: /run/i }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());

    expect(screen.getByText("object 'x' not found")).toBeTruthy();
    expect(screen.getByText(/error/i, { selector: ".code-execution__error-label" })).toBeTruthy();
  });

  it("renders captured plots as canvas elements", async () => {
    // jsdom has no real canvas backend -- stub getContext so the Plot
    // component's drawImage call doesn't log jsdom's own "not implemented"
    // noise for an API this test isn't actually asserting on.
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);

    const fakeBitmap = { width: 4, height: 3 } as unknown as ImageBitmap;
    const onRun = vi.fn().mockResolvedValue({
      status: "success",
      executionTimeMs: 1,
      images: [fakeBitmap],
    } satisfies RCodeResult);
    render(<CodeExecution code="plot(1:10)" onRun={onRun} />);

    fireEvent.click(screen.getByRole("button", { name: /run/i }));
    await waitFor(() => expect(document.querySelector("canvas.code-execution__plot")).toBeTruthy());
    expect(drawImage).toHaveBeenCalledWith(fakeBitmap, 0, 0);

    vi.restoreAllMocks();
  });

  it("re-runs on a second click, replacing the previous result", async () => {
    const onRun = vi.fn().mockResolvedValueOnce(ERROR_RESULT).mockResolvedValueOnce(SUCCESS_RESULT);
    render(<CodeExecution code="x + 1" onRun={onRun} />);

    fireEvent.click(screen.getByRole("button", { name: /run/i }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /run/i }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByText("[1] 47")).toBeTruthy();
    expect(onRun).toHaveBeenCalledTimes(2);
  });
});

describe("renderTextWithCode", () => {
  it("returns the text unchanged (as a single paragraph) when there is no R fence", () => {
    const nodes = renderTextWithCode("just plain text", { keyPrefix: "k" });
    const { container } = render(<>{nodes}</>);
    expect(container.textContent).toBe("just plain text");
    expect(container.querySelector(".code-execution")).toBeNull();
  });

  it("extracts a fenced R block into a runnable CodeExecution, keeping surrounding text", () => {
    const text = "Try this:\n```r\nsum(1:10)\n```\nWhat do you get?";
    const nodes = renderTextWithCode(text, { keyPrefix: "k" });
    const { container } = render(<>{nodes}</>);
    expect(container.textContent).toContain("Try this:");
    expect(container.textContent).toContain("What do you get?");
    expect(container.querySelector(".code-execution")).toBeTruthy();
    expect(screen.getByText("sum(1:10)")).toBeTruthy();
  });

  it("does not treat an untagged fenced block as runnable R code", () => {
    const text = "```\nnot r\n```";
    const nodes = renderTextWithCode(text, { keyPrefix: "k" });
    const { container } = render(<>{nodes}</>);
    expect(container.querySelector(".code-execution")).toBeNull();
    expect(container.textContent).toContain("not r");
  });

  it("handles multiple fenced blocks in one message", () => {
    const text = "```r\na <- 1\n```\nthen\n```r\nb <- 2\n```";
    const nodes = renderTextWithCode(text, { keyPrefix: "k" });
    const { container } = render(<>{nodes}</>);
    expect(container.querySelectorAll(".code-execution").length).toBe(2);
    expect(container.textContent).toContain("then");
  });

  it("threads onRun into the extracted code block", () => {
    const onRun = vi.fn().mockResolvedValue(SUCCESS_RESULT);
    const nodes = renderTextWithCode("```r\n1+1\n```", { keyPrefix: "k", onRun });
    render(<>{nodes}</>);
    fireEvent.click(screen.getByRole("button", { name: /run/i }));
    expect(onRun).toHaveBeenCalledWith("1+1");
  });
});
