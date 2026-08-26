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
    expect(screen.getByText(/couldn't be displayed/i)).toBeTruthy();
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

/* --------------------------------------------------------------------------
   #310: the retry that could not work.

   `reset()` is setState({ error: null }) and nothing else, so it re-renders
   the SAME subtree with the same upstream state. For the deterministic case
   this boundary exists for -- a malformed persisted tool part, loaded from
   the server on every render -- the render throws again immediately, and
   the same "Try again" button came back. A control certain to fail, saying
   nothing about it, is worse than no control.
   -------------------------------------------------------------------------- */
describe("ErrorBoundary retry policy (#310)", () => {
  it("offers the retry on a first failure", () => {
    const spy = suppressConsoleError();
    render(
      <ErrorBoundary>
        <Bomb shouldThrow={true} />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("button", { name: /Try again/ })).toBeTruthy();
    spy.mockRestore();
  });

  it("withdraws the retry once it has been taken and the subtree threw again", async () => {
    const spy = suppressConsoleError();
    render(
      <ErrorBoundary>
        <Bomb shouldThrow={true} />
      </ErrorBoundary>,
    );

    await userEvent.click(screen.getByRole("button", { name: /Try again/ }));

    // Deterministic throw: nothing upstream changed, so it recurs. The
    // button must not come back offering the same certain failure.
    expect(screen.queryByRole("button", { name: /Try again/ })).toBeNull();
    spy.mockRestore();
  });

  it("tells the student what to do instead of the withdrawn retry", async () => {
    const spy = suppressConsoleError();
    render(
      <ErrorBoundary>
        <Bomb shouldThrow={true} />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/If trying again doesn't help/)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /Try again/ }));

    // Removing the control without replacing the guidance would leave a
    // dead end, which is the same defect in a different shape.
    expect(screen.getByText(/Trying again didn't help/)).toBeTruthy();
    spy.mockRestore();
  });

  it("keeps the retry available when it actually worked", async () => {
    const spy = suppressConsoleError();
    function Harness() {
      const [broken, setBroken] = useState(true);
      return (
        <ErrorBoundary>
          <Bomb shouldThrow={broken} />
          <button type="button" onClick={() => setBroken(false)}>
            fix
          </button>
        </ErrorBoundary>
      );
    }
    render(<Harness />);
    expect(screen.getByRole("button", { name: /Try again/ })).toBeTruthy();
    spy.mockRestore();
  });

  it("leaves a caller-supplied fallback's policy entirely to the caller", async () => {
    const spy = suppressConsoleError();
    // The contract change is scoped to the DEFAULT fallback -- a custom one
    // receives `reset` exactly as before and may offer it as often as it
    // likes.
    render(
      <ErrorBoundary
        fallback={(_error, reset) => (
          <button type="button" onClick={reset}>
            custom retry
          </button>
        )}
      >
        <Bomb shouldThrow={true} />
      </ErrorBoundary>,
    );

    await userEvent.click(screen.getByRole("button", { name: "custom retry" }));
    expect(screen.getByRole("button", { name: "custom retry" })).toBeTruthy();
    spy.mockRestore();
  });
});
