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
    // #31: LLM configs is NOT among them any more. It was visible to a TA
    // while the list was fixture-driven static data; now every route behind
    // it is requireInstructorOf, so showing the entry would be a link to a
    // 403 -- which is the dead end #172 exists to remove, not a permission
    // narrowing.
    expect(screen.queryByText("LLM configs")).toBeNull();
  });

  it("shows every entry and the quick actions to an author", () => {
    render(<AdminSidebar {...props} canAuthor />);

    expect(screen.getByText("TA permissions")).toBeTruthy();
    expect(screen.getByText("QUICK ACTIONS")).toBeTruthy();
    expect(screen.getByText("New homework")).toBeTruthy();
  });

  it("shows a TA exactly the non-authoring entries, and nothing else", () => {
    const asAuthor = render(<AdminSidebar {...props} canAuthor />);
    const authorLabels = screen
      .getAllByRole("listitem")
      .map((li) => li.textContent ?? "");
    asAuthor.unmount();

    render(<AdminSidebar {...props} canAuthor={false} />);
    const taLabels = screen.getAllByRole("listitem").map((li) => li.textContent ?? "");

    // #201 (MNT-033) asked for the RELATIONSHIP rather than the totals, and
    // asserted `authorItems - taItems === 1`. That was still a fact about
    // how many author-only entries NAV_ITEMS happened to contain -- #32 and
    // #91 added two more and it failed with a message about a number again.
    //
    // The actual invariant is which entries a TA may reach: the roster, TA
    // permissions and export are all authoring surfaces whose routes 403 for
    // a TA, so a widened filter is a nav entry leading to a denial. Named,
    // so widening it fails here saying what leaked.
    expect(taLabels.some((l) => l.includes("Homeworks"))).toBe(true);
    expect(taLabels.some((l) => l.includes("Submissions"))).toBe(true);
    expect(taLabels.some((l) => l.includes("LLM configs"))).toBe(false);
    expect(taLabels.some((l) => l.includes("Students"))).toBe(false);
    expect(taLabels.some((l) => l.includes("TA permissions"))).toBe(false);
    expect(taLabels.some((l) => l.includes("Export"))).toBe(false);
    // And the author still sees strictly more, so the filter is doing
    // something rather than hiding everything.
    expect(authorLabels.length).toBeGreaterThan(taLabels.length);
    expect(taLabels.length).toBeGreaterThan(0);
  });
});
