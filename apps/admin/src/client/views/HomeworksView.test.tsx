import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
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
    sectionCount: 3,
  },
  {
    id: "hw-2",
    title: "Homework 2",
    description: "Second homework",
    dueDate: "2026-09-01T00:00:00.000Z",
    llmConfigId: "cfg-1",
    status: "draft",
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
      />,
    );

    expect(screen.getByText(/3 sections/)).toBeTruthy();
    expect(screen.getByText(/1 section$/)).toBeTruthy();
    const metaChips = document.querySelectorAll(".admin-record-row__meta-chip");
    expect(metaChips.length).toBe(4); // 2 homeworks × (section count + due date), no submissions chip
    metaChips.forEach((chip) => expect(chip.textContent).not.toMatch(/submissions/i));
  });
});
