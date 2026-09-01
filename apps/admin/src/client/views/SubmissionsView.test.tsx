import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { SubmissionsView, type HomeworkSubmissionsData } from "./SubmissionsView";

afterEach(cleanup);

const BASE_DATA: HomeworkSubmissionsData = {
  homeworkId: "hw-1",
  homeworkTitle: "Homework 1",
  homeworkDueDate: "2026-08-05T00:00:00.000Z",
  sectionHeaders: [
    { id: "s1", order: 1, title: "Section 1" },
    { id: "s2", order: 2, title: "Section 2" },
  ],
  students: [],
  missingSectionWarnings: [],
  aggregateStats: {
    totalStudents: 0,
    activeStudents: 0,
    inactiveStudents: 0,
    totalSubmissions: 0,
    submissionRate: 0,
  },
};

describe("SubmissionsView missing-section warnings", () => {
  it("renders nothing extra when missingSectionWarnings is empty", () => {
    render(<SubmissionsView data={BASE_DATA} onBack={vi.fn()} />);
    expect(screen.queryByText(/hasn't started|haven't started/i)).toBeNull();
  });

  it("shows a banner entry per section with singular phrasing for a single missing student", () => {
    const data: HomeworkSubmissionsData = {
      ...BASE_DATA,
      missingSectionWarnings: [
        { sectionId: "s1", sectionTitle: "Section 1", missingStudentCount: 1 },
      ],
    };
    render(<SubmissionsView data={data} onBack={vi.fn()} />);
    expect(screen.getByText(/student hasn't started "Section 1"/)).toBeTruthy();
  });

  it("shows a banner entry per section with plural phrasing for multiple missing students", () => {
    const data: HomeworkSubmissionsData = {
      ...BASE_DATA,
      missingSectionWarnings: [
        { sectionId: "s1", sectionTitle: "Section 1", missingStudentCount: 4 },
        { sectionId: "s2", sectionTitle: "Section 2", missingStudentCount: 2 },
      ],
    };
    render(<SubmissionsView data={data} onBack={vi.fn()} />);
    expect(screen.getByText(/students haven't started "Section 1"/)).toBeTruthy();
    expect(screen.getByText(/students haven't started "Section 2"/)).toBeTruthy();
  });
});

/** #29/#23: the submission-matrix cell -> transcript-list drill-in. */
describe("SubmissionsView transcript drill-in (#29, closes #23's remaining checkbox)", () => {
  const dataWithOneCell = (cell: Partial<HomeworkSubmissionsData["students"][number]["sections"][number]>): HomeworkSubmissionsData => ({
    ...BASE_DATA,
    sectionHeaders: [{ id: "s1", order: 1, title: "Section 1" }],
    students: [
      {
        studentId: "student-1",
        displayName: "Ada Lovelace",
        email: "ada@example.com",
        sections: [{ sectionId: "s1", status: "in_progress", conversationCount: 1, lastActivityAt: null, hasDeletedConversation: false, submissionId: null, ...cell }],
        totalConversations: 1,
        submissionCount: 0,
        participationStatus: "partial",
        lastActivityAt: null,
      },
    ],
  });

  it("clicking a cell with conversations calls onOpenTranscript with (sectionId, studentId)", () => {
    const onOpenTranscript = vi.fn();
    render(<SubmissionsView data={dataWithOneCell({})} onBack={vi.fn()} onOpenTranscript={onOpenTranscript} />);
    fireEvent.click(screen.getByRole("button", { name: /Section 1: in_progress -- view transcripts/i }));
    expect(onOpenTranscript).toHaveBeenCalledWith("s1", "student-1");
  });

  it("a cell with no conversations at all is not clickable", () => {
    const onOpenTranscript = vi.fn();
    render(
      <SubmissionsView
        data={dataWithOneCell({ status: "missing", conversationCount: 0 })}
        onBack={vi.fn()}
        onOpenTranscript={onOpenTranscript}
      />,
    );
    const cell = screen.getByRole("button", { name: /Section 1: missing/i }) as HTMLButtonElement;
    expect(cell.disabled).toBe(true);
    fireEvent.click(cell);
    expect(onOpenTranscript).not.toHaveBeenCalled();
  });

  it("without onOpenTranscript wired up, every cell stays inert (no crash, no-op)", () => {
    render(<SubmissionsView data={dataWithOneCell({})} onBack={vi.fn()} />);
    const cell = screen.getByRole("button", { name: /Section 1: in_progress/i }) as HTMLButtonElement;
    expect(cell.disabled).toBe(true);
  });
});

describe("SubmissionsView grade drill-in (#75, merge precedence review follow-up)", () => {
  const dataWithSubmittedCell = (): HomeworkSubmissionsData => ({
    ...BASE_DATA,
    sectionHeaders: [{ id: "s1", order: 1, title: "Section 1" }],
    students: [
      {
        studentId: "student-1",
        displayName: "Ada Lovelace",
        email: "ada@example.com",
        sections: [
          {
            sectionId: "s1",
            status: "submitted",
            conversationCount: 1,
            lastActivityAt: null,
            hasDeletedConversation: false,
            submissionId: "sub-1",
          },
        ],
        totalConversations: 1,
        submissionCount: 1,
        participationStatus: "active",
        lastActivityAt: null,
      },
    ],
  });

  it("a gradeable cell calls onGrade with sectionId/studentId, not onOpenTranscript", () => {
    const onGrade = vi.fn();
    const onOpenTranscript = vi.fn();
    render(
      <SubmissionsView
        data={dataWithSubmittedCell()}
        onBack={vi.fn()}
        onOpenTranscript={onOpenTranscript}
        onGrade={onGrade}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Grade Ada Lovelace, Section 1" }));
    expect(onGrade).toHaveBeenCalledWith({
      submissionId: "sub-1",
      studentName: "Ada Lovelace",
      sectionTitle: "Section 1",
      sectionId: "s1",
      studentId: "student-1",
    });
    // #366 review: onGrade carries sectionId/studentId precisely so
    // GradingPanel's own "View transcript" link can still reach this same
    // transcript -- confirming the caller (SubmissionsView, not the click
    // handler itself) is the only place that decides which action a
    // gradeable cell takes.
    expect(onOpenTranscript).not.toHaveBeenCalled();
  });

  it("a submitted cell falls back to onOpenTranscript when the caller cannot grade (TA)", () => {
    const onOpenTranscript = vi.fn();
    render(
      <SubmissionsView
        data={dataWithSubmittedCell()}
        onBack={vi.fn()}
        onOpenTranscript={onOpenTranscript}
        // onGrade absent -- e.g. a TA reading this dashboard, #172.
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Section 1: submitted -- view transcripts/i }));
    expect(onOpenTranscript).toHaveBeenCalledWith("s1", "student-1");
  });
});

/** #167: a submission the scheduled overdue sweep created reads as
 *  "submitted" -- the work exists and is gradeable -- but the cell must not
 *  claim the student declared themselves done. */
describe("SubmissionsView auto-submitted cells (#167)", () => {
  const dataWithCell = (
    cell: Partial<HomeworkSubmissionsData["students"][number]["sections"][number]>,
  ): HomeworkSubmissionsData => ({
    ...BASE_DATA,
    sectionHeaders: [{ id: "s1", order: 1, title: "Section 1" }],
    students: [
      {
        studentId: "student-1",
        displayName: "Ada Lovelace",
        email: "ada@example.com",
        sections: [
          {
            sectionId: "s1",
            status: "submitted",
            conversationCount: 1,
            lastActivityAt: null,
            hasDeletedConversation: false,
            submissionId: "sub-1",
            ...cell,
          },
        ],
        totalConversations: 1,
        submissionCount: 1,
        participationStatus: "active",
        lastActivityAt: null,
      },
    ],
  });

  it("names the auto origin in the cell's accessible label", () => {
    render(
      <SubmissionsView data={dataWithCell({ submissionSource: "auto" })} onBack={vi.fn()} />,
    );
    expect(
      screen.getByRole("button", { name: /Section 1: submitted \(auto-submitted at the due date\)/i }),
    ).toBeTruthy();
  });

  it("says nothing of the sort for a student-initiated submission", () => {
    render(
      <SubmissionsView data={dataWithCell({ submissionSource: "student" })} onBack={vi.fn()} />,
    );
    expect(screen.queryByRole("button", { name: /auto-submitted/i })).toBeNull();
    expect(screen.getByRole("button", { name: /Section 1: submitted/i })).toBeTruthy();
  });

  it("keeps the cell gradeable and carries the note into the grade label", () => {
    const onGrade = vi.fn();
    render(
      <SubmissionsView
        data={dataWithCell({ submissionSource: "auto" })}
        onBack={vi.fn()}
        onGrade={onGrade}
      />,
    );
    const cell = screen.getByRole("button", {
      name: /Grade Ada Lovelace, Section 1 \(auto-submitted at the due date\)/i,
    });
    // The distinction is not carried by the label alone: the modifier class
    // is what makes it visible without a screen reader.
    expect(cell.className).toContain("admin-progress-cell--auto");
    fireEvent.click(cell);
    expect(onGrade).toHaveBeenCalledWith(expect.objectContaining({ submissionId: "sub-1" }));
  });
});
