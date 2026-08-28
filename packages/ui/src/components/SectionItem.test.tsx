// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { SectionItem } from "./SectionItem";

afterEach(cleanup);

/* #167: a section the scheduled overdue sweep submitted is still
   "submitted" -- the ✓ is accurate, the work was captured -- but a student
   who never pressed submit should be told why the row shows as done rather
   than left to assume they did it and forgot. */
describe("SectionItem auto-submitted labelling (#167)", () => {
  it("says the submission was automatic when autoSubmitted is set", () => {
    render(<SectionItem number={1} title="Warm-up" status="submitted" autoSubmitted />);
    const row = screen.getByRole("button");
    expect(row.textContent).toContain("submitted automatically when the due date passed");
    // Sighted parity: without the title the distinction would exist only in
    // the sr-only span.
    expect(row.getAttribute("title")).toContain("submitted automatically when the due date passed");
  });

  it("keeps the plain wording for a student-initiated submission", () => {
    render(<SectionItem number={1} title="Warm-up" status="submitted" />);
    const row = screen.getByRole("button");
    expect(row.textContent).toContain("(submitted)");
    expect(row.textContent).not.toContain("automatically");
    expect(row.getAttribute("title")).toBeNull();
  });

  it("ignores autoSubmitted on a section that is not submitted", () => {
    render(<SectionItem number={2} title="Model" status="current" autoSubmitted />);
    const row = screen.getByRole("button");
    expect(row.textContent).toContain("(current)");
    expect(row.textContent).not.toContain("automatically");
  });
});
