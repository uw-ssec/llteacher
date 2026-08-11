import { describe, it, vi, afterEach, expect } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { AdminSidebar } from "./AdminSidebar";

afterEach(cleanup);

const props = {
  active: "homeworks" as const,
  onNavigate: vi.fn(),
  onNewHomework: vi.fn(),
  onNewLLMConfig: vi.fn(),
};

/** #172 (FUN-001) and its re-audit (FUN-101).
 *
 *  The nav filter and the QUICK ACTIONS gate had no test of any kind. A
 *  re-audit mutation run confirmed the consequence: deleting `authorOnly:
 *  true` from the TA-permissions nav item, or dropping the
 *  `.filter(...)` around NAV_ITEMS, left the entire admin suite green while
 *  reproducing FUN-001 exactly -- a TA shown a nav entry whose every request
 *  403s, which is the precise defect #172 exists to remove. */
describe("AdminSidebar authoring affordances (#172)", () => {
  it("hides the TA-permissions entry and quick actions from a non-author", () => {
    render(<AdminSidebar {...props} canAuthor={false} />);

    // Instructor-only: the backing endpoints are requireInstructorOf, so
    // showing this to a TA offers an action they can never complete.
    expect(screen.queryByText("TA permissions")).toBeNull();
    expect(screen.queryByText("QUICK ACTIONS")).toBeNull();
    expect(screen.queryByText("New homework")).toBeNull();
    expect(screen.queryByText("New LLM config")).toBeNull();
  });

  it("shows the reading entries a TA does have access to", () => {
    render(<AdminSidebar {...props} canAuthor={false} />);

    // A TA is a grader: the console is still useful to them, and hiding the
    // authoring entry must not hide the rest of it.
    expect(screen.getByText("Homeworks")).toBeTruthy();
    expect(screen.getByText("Submissions")).toBeTruthy();
    expect(screen.getByText("LLM configs")).toBeTruthy();
  });

  it("shows every entry and the quick actions to an author", () => {
    render(<AdminSidebar {...props} canAuthor />);

    expect(screen.getByText("TA permissions")).toBeTruthy();
    expect(screen.getByText("QUICK ACTIONS")).toBeTruthy();
    expect(screen.getByText("New homework")).toBeTruthy();
  });

  it("filters exactly one entry, so a widened filter is visible here", () => {
    const asAuthor = render(<AdminSidebar {...props} canAuthor />);
    const authorItems = screen.getAllByRole("listitem").length;
    asAuthor.unmount();

    render(<AdminSidebar {...props} canAuthor={false} />);
    const taItems = screen.getAllByRole("listitem").length;

    // #201 (#172 re-audit, MNT-033): the RELATIONSHIP, not the totals. The
    // old form asserted authorItems === 4 and taItems === 3 -- the size of
    // NAV_ITEMS, which is unrelated to the filter under test, so adding any
    // nav entry failed this test with a message about a number. What it
    // means to pin is "the filter removes exactly one entry"; the entries a
    // TA keeps are asserted by name in the test above.
    expect(authorItems - taItems).toBe(1);
    expect(taItems).toBeGreaterThan(0);
  });
});
