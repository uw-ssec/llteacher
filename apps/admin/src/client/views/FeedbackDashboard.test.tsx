import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

    /* #440 audit fix 1 (Major, Accessibility): App.tsx's
     *  FeedbackDashboardDataLoader used to unmount this whole view (render
     *  `if (!data) return null`) on every pagination click while its new
     *  page fetched -- dropping focus to <body> on every page turn, not
     *  just at a boundary. That loader-level behavior isn't reachable from
     *  this presentational component directly, but the contract it now
     *  relies on IS: FeedbackDashboard must keep the Previous/Next buttons
     *  mounted for any `data` it's given, including while a caller is
     *  mid-fetch for the next page (there is no "unmounted/loading" render
     *  branch in here at all -- these buttons are stable data-testids for a
     *  DataLoader-level test to assert against before/after triggering a
     *  page change with a fetch pending, since a real pending fetch can't be
     *  observed from a component that never fetches). */
    it("keeps Previous/Next mounted regardless of isFetching (stable data-testids)", () => {
      const twoPageData = data({
        items: Array.from({ length: 2 }, (_, i) => item({ id: `f${i}` })),
        total: 4,
        limit: 2,
        offset: 0,
      });
      const { rerender } = render(
        <FeedbackDashboard data={twoPageData} onBack={vi.fn()} onOpenTranscript={vi.fn()} onChangeOffset={vi.fn()} isFetching={false} />,
      );
      expect(screen.getByTestId("feedback-prev-page")).toBeTruthy();
      expect(screen.getByTestId("feedback-next-page")).toBeTruthy();

      // Simulate the loader flipping isFetching while it holds the SAME
      // `data` (the previous page) during a pending fetch -- Fix 1's whole
      // point is that this transition never removes these buttons from the
      // DOM.
      rerender(
        <FeedbackDashboard data={twoPageData} onBack={vi.fn()} onOpenTranscript={vi.fn()} onChangeOffset={vi.fn()} isFetching={true} />,
      );
      expect(screen.getByTestId("feedback-prev-page")).toBeTruthy();
      expect(screen.getByTestId("feedback-next-page")).toBeTruthy();
    });
  });

  /* #440 audit fix 2 (Major, Accessibility): the narrower, button-level case
   *  Fix 1 leaves behind once the whole view stops unmounting -- a boundary
   *  page's Previous/Next is `disabled={!canPrev}` / `disabled={!canNext}`,
   *  and a native `disabled` button cannot hold focus. Landing on a boundary
   *  page with the just-clicked button still focused would otherwise drop
   *  focus to <body> with nothing to restore it -- the same #298 defect
   *  class closed for ResponseFeedback (apps/web) and App.tsx's
   *  HomeworkLoadError, mirrored here via the page-indicator's
   *  tabIndex={-1} + focus() effect. */
  describe("boundary pagination focus (#440 audit fix 2)", () => {
    it("does not drop focus to <body> when Previous becomes disabled on arrival at page 1", async () => {
      const onChangeOffset = vi.fn();
      const twoPageData = (offset: number) =>
        data({
          items: Array.from({ length: 2 }, (_, i) => item({ id: `f${offset}-${i}` })),
          total: 4,
          limit: 2,
          offset,
        });
      const user = userEvent.setup();

      const { rerender } = render(
        <FeedbackDashboard data={twoPageData(2)} onBack={vi.fn()} onOpenTranscript={vi.fn()} onChangeOffset={onChangeOffset} />,
      );

      const prevButton = screen.getByTestId("feedback-prev-page") as HTMLButtonElement;
      // Focuses, then clicks -- same as a real mouse/keyboard user, and what
      // makes this a genuine test of losing focus FROM this button.
      await user.click(prevButton);
      expect(onChangeOffset).toHaveBeenCalledWith(0);
      expect(document.activeElement).toBe(prevButton);

      // The parent applies the offset change by re-rendering with page 1's
      // data -- canPrev flips false and Previous becomes `disabled`, same
      // DOM node (App.tsx really does this via onChangeOffset -> setView ->
      // re-render with the new offset).
      rerender(
        <FeedbackDashboard data={twoPageData(0)} onBack={vi.fn()} onOpenTranscript={vi.fn()} onChangeOffset={onChangeOffset} />,
      );

      expect(prevButton.disabled).toBe(true); // confirms the native disable really happened
      expect(document.activeElement).not.toBe(document.body);
      // Stronger than "not body": jsdom (unlike a real browser) does not
      // itself blur a focused element the instant it becomes `disabled` --
      // it leaves `document.activeElement` pointing at the now-disabled
      // button, which would make a bare "not <body>" assertion pass here
      // even with the fix removed. Assert focus actually moved to the
      // fix's own target, off the disabled button, so this test fails
      // without the fix in this environment too.
      expect(document.activeElement).toBe(screen.getByTestId("feedback-page-indicator"));
      expect(document.activeElement).not.toBe(prevButton);
    });

    it("does not drop focus to <body> when Next becomes disabled on arrival at the last page", async () => {
      const onChangeOffset = vi.fn();
      const twoPageData = (offset: number) =>
        data({
          items: Array.from({ length: 2 }, (_, i) => item({ id: `f${offset}-${i}` })),
          total: 4,
          limit: 2,
          offset,
        });
      const user = userEvent.setup();

      const { rerender } = render(
        <FeedbackDashboard data={twoPageData(0)} onBack={vi.fn()} onOpenTranscript={vi.fn()} onChangeOffset={onChangeOffset} />,
      );

      const nextButton = screen.getByTestId("feedback-next-page") as HTMLButtonElement;
      await user.click(nextButton);
      expect(onChangeOffset).toHaveBeenCalledWith(2);
      expect(document.activeElement).toBe(nextButton);

      rerender(
        <FeedbackDashboard data={twoPageData(2)} onBack={vi.fn()} onOpenTranscript={vi.fn()} onChangeOffset={onChangeOffset} />,
      );

      expect(nextButton.disabled).toBe(true);
      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement).toBe(screen.getByTestId("feedback-page-indicator"));
      expect(document.activeElement).not.toBe(nextButton);
    });
  });

  /* #440 audit fix 3 (Minor, Usability+Accessibility). */
  describe("reason breakdown group (#440 audit fix 3)", () => {
    it("exposes the breakdown as an accessible group", () => {
      render(<FeedbackDashboard data={data()} onBack={vi.fn()} onOpenTranscript={vi.fn()} onChangeOffset={vi.fn()} />);
      expect(screen.getByRole("group", { name: "Reason breakdown" })).toBeTruthy();
    });

    it("shows the page-scoped qualifier as visible text, not just in the aria-label", () => {
      render(<FeedbackDashboard data={data()} onBack={vi.fn()} onOpenTranscript={vi.fn()} onChangeOffset={vi.fn()} />);
      expect(screen.getByText("This page:")).toBeTruthy();
    });
  });
});
