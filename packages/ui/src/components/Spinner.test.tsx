// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Spinner } from "./Spinner";

afterEach(cleanup);

describe("Spinner", () => {
  it.each(["sm", "md", "lg"] as const)("renders a styled child dot for %s", (size) => {
    render(<Spinner size={size} label="Loading homework" />);
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Loading homework");
    const indicator = status.querySelector('[aria-hidden="true"]');
    expect(indicator?.querySelector(`:scope > .spinner--${size}`)).not.toBeNull();
    expect(indicator?.className).toBe("streaming-dot");
  });

  it("defaults to the medium dot and retains the custom class", () => {
    render(<Spinner className="custom-spinner" />);
    const status = screen.getByRole("status");
    expect(status.classList.contains("custom-spinner")).toBe(true);
    expect(status.querySelector(".streaming-dot > .spinner--md")).not.toBeNull();
    expect(status.textContent).toBe("Loading…");
  });
});
