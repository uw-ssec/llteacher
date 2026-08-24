// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { ListControls } from "./ListControls";

afterEach(cleanup);

const FILTERS = [
  { value: "all", label: "All", count: 3 },
  { value: "active", label: "Active", count: 2 },
];
const SORTS = [
  { value: "name", label: "Name" },
  { value: "date", label: "Date" },
];

describe("ListControls — sections are optional", () => {
  it("renders no search field when search is omitted", () => {
    render(<ListControls sort={{ value: "name", onChange: vi.fn(), label: "Sort", options: SORTS }} summary="3 items" />);
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.getByRole("combobox", { name: "Sort" })).toBeTruthy();
  });

  it("renders no filter rail when filter is omitted", () => {
    render(<ListControls sort={{ value: "name", onChange: vi.fn(), label: "Sort", options: SORTS }} summary="3 items" />);
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });
});

describe("ListControls — search", () => {
  it("reports what was typed and can be cleared", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ListControls search={{ value: "", onChange, label: "Search students", placeholder: "Search…" }} summary="3 items" />,
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "Search students" }), { target: { value: "maya" } });
    expect(onChange).toHaveBeenCalledWith("maya");

    // The clear button only exists once there is something to clear.
    rerender(<ListControls search={{ value: "maya", onChange, label: "Search students" }} summary="1 item" />);
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(onChange).toHaveBeenLastCalledWith("");
  });

  it("gives the field an accessible name without showing a visible label", () => {
    render(<ListControls search={{ value: "", onChange: vi.fn(), label: "Search students by name or email" }} summary="3 items" />);
    const box = screen.getByRole("searchbox", { name: "Search students by name or email" });
    const label = document.querySelector(`label[for="${box.id}"]`);
    expect(label?.className).toContain("sr-only");
  });
});

describe("ListControls — filter", () => {
  // The markup this replaces claimed role="tab"/aria-selected with no
  // tabpanel behind it and no arrow-key handling, so assistive tech announced
  // "tab, 1 of 3" and then the arrow keys the user pressed did nothing.
  it("exposes the filters as a radio group, not a tablist", () => {
    render(<ListControls filter={{ value: "all", onChange: vi.fn(), label: "Filter", options: FILTERS }} summary="3 items" />);
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.getByRole("radiogroup", { name: "Filter" })).toBeTruthy();
    expect(screen.getAllByRole("radio")).toHaveLength(2);
  });

  it("marks exactly one option checked and reports a change", () => {
    const onChange = vi.fn();
    render(<ListControls filter={{ value: "all", onChange, label: "Filter", options: FILTERS }} summary="3 items" />);

    expect((screen.getByRole("radio", { name: /All/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("radio", { name: /Active/ }) as HTMLInputElement).checked).toBe(false);

    fireEvent.click(screen.getByRole("radio", { name: /Active/ }));
    expect(onChange).toHaveBeenCalledWith("active");
  });

  it("groups the radios under one name so they are mutually exclusive", () => {
    render(<ListControls filter={{ value: "all", onChange: vi.fn(), label: "Filter", options: FILTERS }} summary="3 items" />);
    const names = new Set(screen.getAllByRole("radio").map((r) => (r as HTMLInputElement).name));
    expect(names.size).toBe(1);
  });

  it("scopes the radio name per instance so two control bars cannot collide", () => {
    render(
      <>
        <ListControls filter={{ value: "all", onChange: vi.fn(), label: "A", options: FILTERS }} summary="x" />
        <ListControls filter={{ value: "all", onChange: vi.fn(), label: "B", options: FILTERS }} summary="y" />
      </>,
    );
    const names = new Set(screen.getAllByRole("radio").map((r) => (r as HTMLInputElement).name));
    expect(names.size).toBe(2);
  });
});

describe("ListControls — result summary", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const live = () => document.querySelector('[role="status"]');

  it("announces the initial count immediately rather than after the debounce", () => {
    render(<ListControls summary="3 homeworks" />);
    expect(live()?.textContent).toBe("3 homeworks");
  });

  // The visible count must track every keystroke; the announcement must not,
  // or a screen-reader user hears a new number per character and never hears
  // one to its end.
  it("shows a new count at once but waits for a pause before announcing it", () => {
    const { rerender } = render(<ListControls summary="3 homeworks" />);
    rerender(<ListControls summary="Showing 1 of 3 homeworks" />);

    expect(screen.getByText("Showing 1 of 3 homeworks")).toBeTruthy();
    expect(live()?.textContent).toBe("3 homeworks");

    act(() => void vi.advanceTimersByTime(600));
    expect(live()?.textContent).toBe("Showing 1 of 3 homeworks");
  });

  // Each new count must CANCEL the pending announcement, not queue behind it.
  // The timing here is what makes that observable: a run of updates followed
  // by one long wait ends on the same final text either way, so it has to
  // catch the superseded announcement in the window where it would have
  // fired. (Verified by mutation: the naive version of this test passed with
  // the timer cleanup removed entirely.)
  it("cancels a pending announcement when a newer count arrives", () => {
    const { rerender } = render(<ListControls summary="3 homeworks" />);

    rerender(<ListControls summary="Showing 2 of 3" />); // schedules at t=500
    act(() => void vi.advanceTimersByTime(400)); // t=400, not yet fired
    rerender(<ListControls summary="Showing 1 of 3" />); // must cancel the above
    act(() => void vi.advanceTimersByTime(200)); // t=600 — the cancelled one would have fired at 500

    expect(live()?.textContent).toBe("3 homeworks");

    act(() => void vi.advanceTimersByTime(400)); // t=1000, the surviving timer fires
    expect(live()?.textContent).toBe("Showing 1 of 3");
  });

  // A live region inserted at the same moment its text appears is frequently
  // missed: the announcement has to land in a region the screen reader was
  // already watching.
  it("keeps the live region mounted from the first render", () => {
    render(<ListControls summary="3 homeworks" />);
    const region = live();
    expect(region).toBeTruthy();
    expect(region?.getAttribute("aria-live")).toBe("polite");
  });

  it("does not read the visible copy twice to a screen reader", () => {
    render(<ListControls summary="3 homeworks" />);
    // The visible span is hidden from AT; the live region carries the text.
    const visible = document.querySelector(".list-controls__summary > [aria-hidden='true']");
    expect(visible?.textContent).toBe("3 homeworks");
    expect(live()?.className).toContain("sr-only");
  });
});
