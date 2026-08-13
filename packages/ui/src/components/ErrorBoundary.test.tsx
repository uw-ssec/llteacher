// @vitest-environment jsdom
import { useState } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ErrorBoundary } from "./ErrorBoundary";

afterEach(cleanup);

/* A component that throws on render whenever `shouldThrow` is true --
   standard React error-boundary test fixture. */
function Bomb({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error("boom");
  return <p>fine</p>;
}

// React logs caught errors to console.error twice (once via its own dev
// warning, once via componentDidCatch's own console.error call here) --
// expected noise for every test in this file, not a real failure.
function suppressConsoleError() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}

describe("ErrorBoundary", () => {
  it("renders children normally when nothing throws", () => {
    render(
      <ErrorBoundary>
        <Bomb shouldThrow={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText("fine")).toBeTruthy();
  });

  it("catches a render throw and shows the default fallback instead of propagating it", () => {
    const consoleError = suppressConsoleError();
    render(
      <ErrorBoundary>
        <Bomb shouldThrow={true} />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText(/something went wrong/i)).toBeTruthy();
    expect(screen.queryByText("fine")).toBeNull();
    consoleError.mockRestore();
  });

  // #298: the caught error drops the throwing subtree (and whatever had
  // focus in it) -- without this, focus falls to <body> and a keyboard
  // user has no located way back to the retry affordance.
  it("moves focus to the default fallback the instant it appears", () => {
    const consoleError = suppressConsoleError();
    render(
      <ErrorBoundary>
        <Bomb shouldThrow={true} />
      </ErrorBoundary>,
    );
    expect(document.activeElement).toBe(screen.getByRole("alert"));
    consoleError.mockRestore();
  });

  it("logs the caught error via componentDidCatch instead of silently swallowing it", () => {
    const consoleError = suppressConsoleError();
    render(
      <ErrorBoundary>
        <Bomb shouldThrow={true} />
      </ErrorBoundary>,
    );
    expect(consoleError).toHaveBeenCalledWith(
      "[ErrorBoundary] caught a render error",
      expect.any(Error),
      expect.anything(),
    );
    consoleError.mockRestore();
  });

  it("invokes a custom fallback with the error and a working reset callback", async () => {
    const consoleError = suppressConsoleError();
    function TestHarness() {
      return (
        <ErrorBoundary
          fallback={(error, reset) => (
            <div>
              <p>custom: {error.message}</p>
              <button onClick={reset}>reset</button>
            </div>
          )}
        >
          <Bomb shouldThrow={true} />
        </ErrorBoundary>
      );
    }
    render(<TestHarness />);
    expect(screen.getByText("custom: boom")).toBeTruthy();
    consoleError.mockRestore();
  });

  it("re-renders children after reset() when the child no longer throws", async () => {
    const consoleError = suppressConsoleError();
    function TestHarness() {
      const [shouldThrow, setShouldThrow] = useState(true);
      return (
        <div>
          <button onClick={() => setShouldThrow(false)}>fix upstream</button>
          <ErrorBoundary
            fallback={(_error: Error, reset: () => void) => (
              <button onClick={reset}>retry</button>
            )}
          >
            <Bomb shouldThrow={shouldThrow} />
          </ErrorBoundary>
        </div>
      );
    }
    render(<TestHarness />);
    const user = userEvent.setup();

    expect(screen.getByRole("button", { name: "retry" })).toBeTruthy();

    // Fix whatever caused the throw upstream, then retry from the boundary.
    await user.click(screen.getByRole("button", { name: "fix upstream" }));
    await user.click(screen.getByRole("button", { name: "retry" }));

    expect(await screen.findByText("fine")).toBeTruthy();
    consoleError.mockRestore();
  });
});
