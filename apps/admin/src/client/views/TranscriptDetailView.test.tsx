import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { TranscriptDetailView, type TranscriptDetailData } from "./TranscriptDetailView";

// jsdom doesn't implement scrollIntoView -- ConversationView's own
// scroll-to-bottom effect calls it on every render. Same fix
// ConversationView.test.tsx and apps/web's App.test.tsx already apply.
Element.prototype.scrollIntoView = vi.fn();

afterEach(cleanup);

const BASE_CONVERSATION: TranscriptDetailData["conversation"] = {
  id: "conv-1",
  studentId: "student-1",
  studentName: "Ada Lovelace",
  sectionId: "sec-1",
  sectionTitle: "Section 2: Confidence intervals",
  homeworkId: "hw-1",
  homeworkTitle: "HW 1",
  isTeacherTest: false,
  isDeleted: false,
  deletedAt: null,
  submission: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

function data(overrides: Partial<TranscriptDetailData> = {}): TranscriptDetailData {
  return {
    conversation: BASE_CONVERSATION,
    messages: [
      { id: "m1", role: "assistant", parts: [{ type: "text", text: "Hello! How can I help?" }], createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "m2", role: "user", parts: [{ type: "text", text: "What is a p-value?" }], createdAt: "2026-01-01T00:01:00.000Z" },
    ],
    hasMore: false,
    offset: 0,
    ...overrides,
  };
}

/** #29: "renders without useChat" -- the corrected brief's own framing.
 *  ConversationView is exercised here through TranscriptDetailView with a
 *  purely static message array and no live-instance props, proving the
 *  reuse (rather than a forked read-only component) actually works. */
describe("TranscriptDetailView (#29)", () => {
  it("renders the student's name and section/homework breadcrumb", () => {
    render(<TranscriptDetailView data={data()} onBack={vi.fn()} onLoadMore={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Ada Lovelace" })).toBeTruthy();
    // Appears twice by design: once in the page subtitle, once in
    // ConversationView's own breadcrumb row -- both read the same string.
    expect(screen.getAllByText(/HW 1 · Section 2: Confidence intervals/).length).toBeGreaterThanOrEqual(2);
  });

  it("renders the full message history: assistant text and student text", () => {
    render(<TranscriptDetailView data={data()} onBack={vi.fn()} onLoadMore={vi.fn()} />);
    expect(screen.getByText("Hello! How can I help?")).toBeTruthy();
    expect(screen.getByText("What is a p-value?")).toBeTruthy();
  });

  it("renders a system message distinctly (visible, not blanked)", () => {
    render(
      <TranscriptDetailView
        data={data({
          messages: [
            { id: "sys-1", role: "system", parts: [{ type: "text", text: "Section restarted by student." }], createdAt: "2026-01-01T00:02:00.000Z" },
          ],
        })}
        onBack={vi.fn()} onLoadMore={vi.fn()}
      />,
    );
    expect(screen.getByText("Section restarted by student.")).toBeTruthy();
  });

  it("renders R code + execution output read-only via the shared CodeExecution renderer (#28)", () => {
    render(
      <TranscriptDetailView
        data={data({
          messages: [
            {
              id: "m3",
              role: "user",
              parts: [{ type: "text", text: "```r\nsum(1:10)\n```" }],
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        })}
        onBack={vi.fn()} onLoadMore={vi.fn()}
      />,
    );
    expect(screen.getByText("sum(1:10)")).toBeTruthy();
    // Read-only: no Run affordance, since no onRun handler is threaded
    // through (CodeExecution's own documented graceful degradation).
    expect(screen.queryByRole("button", { name: /run/i })).toBeNull();
    expect(screen.getByText(/R execution isn.t available here/i)).toBeTruthy();
  });

  it("copy-safe: renders no composer/textbox at all", () => {
    render(<TranscriptDetailView data={data()} onBack={vi.fn()} onLoadMore={vi.fn()} />);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByPlaceholderText(/ask, explore/i)).toBeNull();
  });

  it("shows 'not submitted' when there's no submission", () => {
    render(<TranscriptDetailView data={data()} onBack={vi.fn()} onLoadMore={vi.fn()} />);
    expect(screen.getByText(/not submitted/i)).toBeTruthy();
  });

  it("shows submitted status and timestamp when there is a submission", () => {
    render(
      <TranscriptDetailView
        data={data({
          conversation: { ...BASE_CONVERSATION, submission: { id: "sub-1", submittedAt: "2026-01-03T00:00:00.000Z" } },
        })}
        onBack={vi.fn()} onLoadMore={vi.fn()}
      />,
    );
    expect(screen.getByText(/^submitted$/i)).toBeTruthy();
    expect(screen.getByText(/Submitted /)).toBeTruthy();
  });

  it("marks a teacher-test conversation", () => {
    render(
      <TranscriptDetailView data={data({ conversation: { ...BASE_CONVERSATION, isTeacherTest: true } })} onBack={vi.fn()} onLoadMore={vi.fn()} />,
    );
    expect(screen.getByText(/test conversation/i)).toBeTruthy();
  });

  it("flags a soft-deleted conversation without hiding its messages", () => {
    render(
      <TranscriptDetailView
        data={data({
          conversation: { ...BASE_CONVERSATION, isDeleted: true, deletedAt: "2026-01-04T00:00:00.000Z" },
        })}
        onBack={vi.fn()} onLoadMore={vi.fn()}
      />,
    );
    expect(screen.getByText(/deleted/i)).toBeTruthy();
    // Still shown, not filtered out (differs from the student-facing view).
    expect(screen.getByText("Hello! How can I help?")).toBeTruthy();
  });

  it("shows a truncation notice when hasMore is true", () => {
    render(<TranscriptDetailView data={data({ hasMore: true })} onBack={vi.fn()} onLoadMore={vi.fn()} />);
    expect(screen.getByText(/continues beyond what.s shown/i)).toBeTruthy();
  });

  it("shows no truncation notice when hasMore is false", () => {
    render(<TranscriptDetailView data={data({ hasMore: false })} onBack={vi.fn()} onLoadMore={vi.fn()} />);
    expect(screen.queryByText(/continues beyond what.s shown/i)).toBeNull();
  });

  it("calls onBack from the back control", () => {
    const onBack = vi.fn();
    render(<TranscriptDetailView data={data()} onBack={onBack} onLoadMore={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /back to transcripts/i }));
    expect(onBack).toHaveBeenCalled();
  });

  it("falls back to a placeholder for an unnamed student rather than a blank heading", () => {
    render(
      <TranscriptDetailView data={data({ conversation: { ...BASE_CONVERSATION, studentName: "" } })} onBack={vi.fn()} onLoadMore={vi.fn()} />,
    );
    expect(screen.getByRole("heading", { name: /unnamed student/i })).toBeTruthy();
  });

  // #371: hasMore was previously received and never rendered as anything
  // actionable -- these prove the "Load more" affordance actually appears
  // and actually calls back out to the loader.
  describe("hasMore paging (#371)", () => {
    it("shows a 'Load more messages' control when hasMore is true", () => {
      render(<TranscriptDetailView data={data({ hasMore: true })} onBack={vi.fn()} onLoadMore={vi.fn()} />);
      expect(screen.getByRole("button", { name: /load more messages/i })).toBeTruthy();
    });

    it("does not show a 'Load more' control when hasMore is false", () => {
      render(<TranscriptDetailView data={data({ hasMore: false })} onBack={vi.fn()} onLoadMore={vi.fn()} />);
      expect(screen.queryByRole("button", { name: /load more messages/i })).toBeNull();
    });

    it("calls onLoadMore when the control is clicked", () => {
      const onLoadMore = vi.fn();
      render(<TranscriptDetailView data={data({ hasMore: true })} onBack={vi.fn()} onLoadMore={onLoadMore} />);
      fireEvent.click(screen.getByRole("button", { name: /load more messages/i }));
      expect(onLoadMore).toHaveBeenCalledTimes(1);
    });

    it("disables the control and shows a loading label while loadingMore is true", () => {
      render(
        <TranscriptDetailView data={data({ hasMore: true })} onBack={vi.fn()} onLoadMore={vi.fn()} loadingMore />,
      );
      const button = screen.getByRole("button", { name: /loading/i });
      expect(button).toBeTruthy();
      expect((button as HTMLButtonElement).disabled).toBe(true);
    });

    // Review follow-up (#366 review): a failed "load more" used to swap the
    // WHOLE view for a full-page error, hiding the messages already shown.
    it("shows an inline retry, not a full-page error, when loadMoreError is true", () => {
      render(
        <TranscriptDetailView
          data={data({ hasMore: true })}
          onBack={vi.fn()}
          onLoadMore={vi.fn()}
          loadMoreError
          onRetryLoadMore={vi.fn()}
        />,
      );
      // The already-loaded transcript is still on screen...
      expect(screen.getByText("Ada Lovelace")).toBeTruthy();
      // ...and the normal "Load more" button is replaced by an inline retry.
      expect(screen.queryByRole("button", { name: "Load more messages" })).toBeNull();
      expect(screen.getByRole("alert")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    });

    it("calls onRetryLoadMore when the inline retry is clicked", () => {
      const onRetryLoadMore = vi.fn();
      render(
        <TranscriptDetailView
          data={data({ hasMore: true })}
          onBack={vi.fn()}
          onLoadMore={vi.fn()}
          loadMoreError
          onRetryLoadMore={onRetryLoadMore}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(onRetryLoadMore).toHaveBeenCalledTimes(1);
    });
  });
});
