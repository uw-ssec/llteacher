import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Forbidden } from "./Forbidden";

describe("Forbidden", () => {
  it("renders a branded 403 message", () => {
    render(<Forbidden />);
    expect(screen.getByText(/403/)).toBeTruthy();
    expect(screen.getByText(/instructor/i)).toBeTruthy();
  });
});
