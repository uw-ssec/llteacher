import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
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
