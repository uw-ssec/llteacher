import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { HomeworksView, type HomeworkListItemResponse } from "./HomeworksView";

afterEach(cleanup);

const HOMEWORKS: HomeworkListItemResponse[] = [
  {
    id: "hw-1",
    title: "Homework 1",
    description: "First homework",
    dueDate: "2026-08-05T14:30:00.000Z",
    llmConfigId: null,
    status: "active",
    isHidden: false,
    expiresAt: null,
    sectionCount: 3,
  },
  {
    id: "hw-2",
    title: "Homework 2",
    description: "Second homework",
    dueDate: "2026-09-01T00:00:00.000Z",
    llmConfigId: "cfg-1",
    status: "draft",
    isHidden: false,
    expiresAt: null,
    sectionCount: 1,
  },
];

describe("HomeworksView", () => {
  it("renders the real list payload shape without crashing on the removed fixture fields", () => {
    render(
      <HomeworksView
        homeworks={HOMEWORKS}
        onOpenHomework={vi.fn()}
        onOpenSubmissions={vi.fn()}
        onNewHomework={vi.fn()}
        canAuthor
        canViewDrafts
      />,
    );

    expect(screen.getByText("Homework 1")).toBeTruthy();
    expect(screen.getByText("Homework 2")).toBeTruthy();
  });

  it("renders only the Records and Active stat cards", () => {
    render(
      <HomeworksView
        homeworks={HOMEWORKS}
        onOpenHomework={vi.fn()}
        onOpenSubmissions={vi.fn()}
        onNewHomework={vi.fn()}
        canAuthor
        canViewDrafts
      />,
    );

    const summary = screen.getByRole("list", { name: /catalog summary/i });
    const labels = Array.from(summary.querySelectorAll(".admin-stat__label")).map((el) => el.textContent);
    expect(labels).toEqual(["Records", "Active"]);
  });

  it("derives the Active count from status and the record badge index from array position", () => {
    render(
      <HomeworksView
        homeworks={HOMEWORKS}
        onOpenHomework={vi.fn()}
        onOpenSubmissions={vi.fn()}
        onNewHomework={vi.fn()}
        canAuthor
        canViewDrafts
      />,
    );

    // 1 of 2 fixtures has status "active"
    const summary = screen.getByRole("list", { name: /catalog summary/i });
    const values = Array.from(summary.querySelectorAll(".admin-stat__value")).map((el) => el.textContent);
    expect(values).toEqual(["2", "1"]);

    expect(screen.getByLabelText("Record HW-001")).toBeTruthy();
    expect(screen.getByLabelText("Record HW-002")).toBeTruthy();
  });

  it("renders sectionCount instead of a submissions-count chip", () => {
    render(
      <HomeworksView
        homeworks={HOMEWORKS}
        onOpenHomework={vi.fn()}
        onOpenSubmissions={vi.fn()}
        onNewHomework={vi.fn()}
        canAuthor
        canViewDrafts
      />,
    );

    expect(screen.getByText(/3 sections/)).toBeTruthy();
    expect(screen.getByText(/1 section$/)).toBeTruthy();
    const metaChips = document.querySelectorAll(".admin-record-row__meta-chip");
    expect(metaChips.length).toBe(4); // 2 homeworks × (section count + due date), no submissions chip
    metaChips.forEach((chip) => expect(chip.textContent).not.toMatch(/submissions/i));
  });

  // #166
  it("renders a hidden StatusBadge for a homework with status: hidden", () => {
    const homeworks: HomeworkListItemResponse[] = [
      { ...HOMEWORKS[0]!, status: "hidden", isHidden: true },
    ];
    render(
      <HomeworksView
        homeworks={homeworks}
        onOpenHomework={vi.fn()}
        onOpenSubmissions={vi.fn()}
        onNewHomework={vi.fn()}
        canAuthor
        canViewDrafts
      />,
    );

    // Scoped to the record list: the status filter rail also offers a chip
    // labelled "hidden", so an unscoped getByText now matches both. Both are
    // correct on screen -- the badge states this homework's status, the chip
    // filters to it -- so the test narrows rather than the UI changing.
    const list = screen.getByRole("region", { name: "Homeworks" });
    expect(within(list).getByText("hidden")).toBeTruthy();
    expect(list.querySelector(".admin-status--hidden")).toBeTruthy();
  });
});

/** #187 (#172 re-audit, USE-022): the list route silently filters
 *  draft/scheduled/hidden homeworks for a caller without can_view_drafts,
 *  and this view rendered the truncated result as fact ("N RECORDS"). The
 *  solutions half of the same grant explained itself; the drafts half did
 *  not, so a TA could not tell "not granted" from "never saved". */
describe("HomeworksView unreleased-content notice (#172, USE-022)", () => {
  const props = {
    homeworks: HOMEWORKS,
    onOpenHomework: vi.fn(),
    onOpenSubmissions: vi.fn(),
    onNewHomework: vi.fn(),
  };

  it("explains the filtered list to a caller without the drafts grant", () => {
    render(<HomeworksView {...props} canAuthor={false} canViewDrafts={false} />);
    expect(screen.getByText(/draft, scheduled, or hidden status are not shown/i)).toBeTruthy();
    // Names where the grant comes from, so the reader has a next action.
    expect(screen.getByText(/TA permissions/i)).toBeTruthy();
  });

  it("shows no notice to a caller who holds the grant", () => {
    render(<HomeworksView {...props} canAuthor={false} canViewDrafts />);
    expect(screen.queryByText(/are not shown/i)).toBeNull();
  });

  it("shows no notice to an instructor", () => {
    render(<HomeworksView {...props} canAuthor canViewDrafts />);
    expect(screen.queryByText(/are not shown/i)).toBeNull();
  });
});
