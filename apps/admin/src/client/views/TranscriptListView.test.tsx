import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { TranscriptListView, type TranscriptListData, type TranscriptListItem } from "./TranscriptListView";

afterEach(cleanup);

function item(overrides: Partial<TranscriptListItem> = {}): TranscriptListItem {
  return {
    conversationId: "conv-1",
    studentId: "student-1",
    studentName: "Ada Lovelace",
    sectionId: "sec-1",
    sectionTitle: "Section 2: Confidence intervals",
    homeworkId: "hw-1",
    homeworkTitle: "HW 1",
    isTeacherTest: false,
    isDeleted: false,
    messageCount: 4,
    lastMessageSnippet: "thanks for the help!",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

function data(overrides: Partial<TranscriptListData> = {}): TranscriptListData {
  return { items: [item()], total: 1, limit: 50, offset: 0, ...overrides };
}

describe("TranscriptListView (#29)", () => {
  it("renders a row per conversation with the student's name and section", () => {
    render(<TranscriptListView data={data()} onBack={vi.fn()} onOpenTranscript={vi.fn()} onChangeOffset={vi.fn()} />);
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    expect(screen.getByText("Section 2: Confidence intervals")).toBeTruthy();
    expect(screen.getByText(/thanks for the help/i)).toBeTruthy();
  });

  it("clicking a row calls onOpenTranscript with that conversation's id", () => {
    const onOpenTranscript = vi.fn();
    render(
      <TranscriptListView data={data()} onBack={vi.fn()} onOpenTranscript={onOpenTranscript} onChangeOffset={vi.fn()} />,
    );
    fireEvent.click(screen.getByText("Ada Lovelace"));
    expect(onOpenTranscript).toHaveBeenCalledWith("conv-1");
  });

  it("flags a soft-deleted conversation without hiding it (differs from the student-facing list)", () => {
    render(
      <TranscriptListView
        data={data({ items: [item({ isDeleted: true })] })}
        onBack={vi.fn()}
        onOpenTranscript={vi.fn()}
        onChangeOffset={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/deleted conversation/i)).toBeTruthy();
    // Still shown, not filtered out.
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
  });

  it("marks a teacher-test conversation", () => {
    render(
      <TranscriptListView
        data={data({ items: [item({ isTeacherTest: true })] })}
        onBack={vi.fn()}
        onOpenTranscript={vi.fn()}
        onChangeOffset={vi.fn()}
      />,
    );
    expect(screen.getByText(/test conversation/i)).toBeTruthy();
  });

  it("shows an empty state when there are no conversations", () => {
    render(
      <TranscriptListView data={data({ items: [], total: 0 })} onBack={vi.fn()} onOpenTranscript={vi.fn()} onChangeOffset={vi.fn()} />,
    );
    expect(screen.getByText(/no conversations yet/i)).toBeTruthy();
  });

  it("calling onBack from the back control", () => {
    const onBack = vi.fn();
    render(<TranscriptListView data={data()} onBack={onBack} onOpenTranscript={vi.fn()} onChangeOffset={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    expect(onBack).toHaveBeenCalled();
  });

  describe("pagination", () => {
    it("hides pagination controls when everything fits on one page", () => {
      render(
        <TranscriptListView data={data({ total: 1, limit: 50 })} onBack={vi.fn()} onOpenTranscript={vi.fn()} onChangeOffset={vi.fn()} />,
      );
      expect(screen.queryByRole("button", { name: /^next$/i })).toBeNull();
    });

    it("Previous is disabled and Next is enabled on the first page", () => {
      render(
        <TranscriptListView
          data={data({ items: Array.from({ length: 2 }, (_, i) => item({ conversationId: `c${i}` })), total: 25, limit: 2, offset: 0 })}
          onBack={vi.fn()}
          onOpenTranscript={vi.fn()}
          onChangeOffset={vi.fn()}
        />,
      );
      expect((screen.getByRole("button", { name: /previous/i }) as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByRole("button", { name: /^next$/i }) as HTMLButtonElement).disabled).toBe(false);
    });

    it("Next calls onChangeOffset with offset advanced by limit", () => {
      const onChangeOffset = vi.fn();
      render(
        <TranscriptListView
          data={data({ items: Array.from({ length: 2 }, (_, i) => item({ conversationId: `c${i}` })), total: 25, limit: 2, offset: 0 })}
          onBack={vi.fn()}
          onOpenTranscript={vi.fn()}
          onChangeOffset={onChangeOffset}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
      expect(onChangeOffset).toHaveBeenCalledWith(2);
    });

    it("Next is disabled and Previous enabled on the last page", () => {
      render(
        <TranscriptListView
          data={data({ items: [item()], total: 25, limit: 2, offset: 24 })}
          onBack={vi.fn()}
          onOpenTranscript={vi.fn()}
          onChangeOffset={vi.fn()}
        />,
      );
      expect((screen.getByRole("button", { name: /previous/i }) as HTMLButtonElement).disabled).toBe(false);
      expect((screen.getByRole("button", { name: /^next$/i }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("Previous never goes below offset 0", () => {
      const onChangeOffset = vi.fn();
      render(
        <TranscriptListView
          data={data({ items: Array.from({ length: 2 }, (_, i) => item({ conversationId: `c${i}` })), total: 25, limit: 2, offset: 1 })}
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
