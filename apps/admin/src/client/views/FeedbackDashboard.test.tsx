import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { FeedbackDashboard, type FeedbackDashboardData, type FeedbackListItem } from "./FeedbackDashboard";

afterEach(cleanup);

function item(overrides: Partial<FeedbackListItem> = {}): FeedbackListItem {
  return {
    id: "flag-1",
    conversationId: "conv-1",
    messageId: "msg-1",
    studentId: "student-1",
    studentName: "Ada Lovelace",
    reason: "incorrect",
    comment: null,
    responseSnapshot: [{ type: "text", text: "The standard error is 5." }],
    isDeleted: false,
    sectionId: "sec-1",
    sectionTitle: "Section 2: Confidence intervals",
    homeworkId: "hw-1",
    homeworkTitle: "HW 1",
    flaggedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function data(overrides: Partial<FeedbackDashboardData> = {}): FeedbackDashboardData {
  return { items: [item()], total: 1, limit: 50, offset: 0, ...overrides };
}

describe("FeedbackDashboard (#90)", () => {
  it("renders a row per flag with the student's name, reason, homework, section, and a text preview", () => {
    render(<FeedbackDashboard data={data()} onBack={vi.fn()} onOpenTranscript={vi.fn()} onChangeOffset={vi.fn()} />);
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    expect(screen.getAllByText("Incorrect").length).toBeGreaterThan(0);
    // #90 review (Minor #6): homeworkTitle is now actually rendered.
    expect(screen.getByText("HW 1")).toBeTruthy();
    expect(screen.getByText("Section 2: Confidence intervals")).toBeTruthy();
    expect(screen.getByText(/The standard error is 5/)).toBeTruthy();
  });

  // #90 review (Minor #5): same dagger convention TranscriptListView.test.tsx
  // already covers for the identical case.
  it("flags a soft-deleted conversation's flag without hiding it", () => {
    render(
      <FeedbackDashboard
        data={data({ items: [item({ isDeleted: true })] })}
        onBack={vi.fn()}
        onOpenTranscript={vi.fn()}
        onChangeOffset={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/deleted conversation/i)).toBeTruthy();
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
  });

  it("shows the student's optional comment as a quote when present", () => {
    render(
      <FeedbackDashboard
        data={data({ items: [item({ comment: "This gave away the final number." })] })}
        onBack={vi.fn()}
        onOpenTranscript={vi.fn()}
        onChangeOffset={vi.fn()}
      />,
    );
    expect(screen.getByText(/This gave away the final number/)).toBeTruthy();
  });

  it("renders no comment quote when comment is null", () => {
    render(<FeedbackDashboard data={data()} onBack={vi.fn()} onOpenTranscript={vi.fn()} onChangeOffset={vi.fn()} />);
    expect(screen.queryByText(/“/)).toBeNull(); // no opening curly quote rendered
  });

  it("clicking a row calls onOpenTranscript with that flag's item", () => {
    const onOpenTranscript = vi.fn();
    render(
      <FeedbackDashboard data={data()} onBack={vi.fn()} onOpenTranscript={onOpenTranscript} onChangeOffset={vi.fn()} />,
    );
    fireEvent.click(screen.getByText("Ada Lovelace"));
    expect(onOpenTranscript).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "conv-1" }));
  });

  it("computes a reason breakdown across the current page's items", () => {
    render(
      <FeedbackDashboard
        data={data({
          items: [
            item({ id: "f1", reason: "incorrect" }),
            item({ id: "f2", reason: "incorrect" }),
            item({ id: "f3", reason: "confusing" }),
          ],
          total: 3,
        })}
        onBack={vi.fn()}
        onOpenTranscript={vi.fn()}
        onChangeOffset={vi.fn()}
      />,
    );
    expect(screen.getByText("Incorrect: 2")).toBeTruthy();
    expect(screen.getByText("Confusing: 1")).toBeTruthy();
    expect(screen.getByText("Gave away the answer: 0")).toBeTruthy();
    expect(screen.getByText("Other: 0")).toBeTruthy();
  });

  it("shows an empty state when there are no flags", () => {
    render(
      <FeedbackDashboard data={data({ items: [], total: 0 })} onBack={vi.fn()} onOpenTranscript={vi.fn()} onChangeOffset={vi.fn()} />,
    );
    expect(screen.getByText(/no flagged responses yet/i)).toBeTruthy();
  });

  it("calls onBack from the back control", () => {
    const onBack = vi.fn();
    render(<FeedbackDashboard data={data()} onBack={onBack} onOpenTranscript={vi.fn()} onChangeOffset={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    expect(onBack).toHaveBeenCalled();
  });

  describe("pagination", () => {
    it("hides pagination controls when everything fits on one page", () => {
      render(
        <FeedbackDashboard data={data({ total: 1, limit: 50 })} onBack={vi.fn()} onOpenTranscript={vi.fn()} onChangeOffset={vi.fn()} />,
      );
      expect(screen.queryByRole("button", { name: /^next$/i })).toBeNull();
    });

    it("Next calls onChangeOffset with offset advanced by limit", () => {
      const onChangeOffset = vi.fn();
      render(
        <FeedbackDashboard
          data={data({ items: Array.from({ length: 2 }, (_, i) => item({ id: `f${i}` })), total: 25, limit: 2, offset: 0 })}
          onBack={vi.fn()}
          onOpenTranscript={vi.fn()}
          onChangeOffset={onChangeOffset}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
      expect(onChangeOffset).toHaveBeenCalledWith(2);
    });

    it("Previous never goes below offset 0", () => {
      const onChangeOffset = vi.fn();
      render(
        <FeedbackDashboard
          data={data({ items: Array.from({ length: 2 }, (_, i) => item({ id: `f${i}` })), total: 25, limit: 2, offset: 1 })}
          onBack={vi.fn()}
          onOpenTranscript={vi.fn()}
          onChangeOffset={onChangeOffset}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: /previous/i }));
      expect(onChangeOffset).toHaveBeenCalledWith(0);
    });
  });
});
