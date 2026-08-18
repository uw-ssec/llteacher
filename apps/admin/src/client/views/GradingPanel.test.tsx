/* --------------------------------------------------------------------------
   #75: the grading panel.

   The invariant worth testing on this screen is the one the whole feature
   rests on: an AI draft is never a grade. The schema makes that true; this
   file pins that the UI does not quietly undo it by submitting on the
   instructor's behalf.
   -------------------------------------------------------------------------- */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { GradingPanel } from "./GradingPanel";

afterEach(cleanup);

const HUMAN_GRADE = {
  id: "g-1",
  submissionId: "s-1",
  score: 82,
  maxScore: 100,
  feedback: "Solid reasoning throughout.",
  graderType: "human" as const,
  graderName: "Anjali Chen",
  supersedesGradeId: null,
  isCurrent: true,
  createdAt: "2026-03-01T10:00:00.000Z",
};
const AI_GRADE = {
  ...HUMAN_GRADE,
  id: "g-2",
  score: 95,
  feedback: "The student reasoned well.",
  graderType: "ai" as const,
  graderName: "",
  isCurrent: false,
  createdAt: "2026-03-02T10:00:00.000Z",
};

function stub(handler: (url: string, init: RequestInit) => Response) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init ?? {}),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

const gradesResponse = (grades: unknown[]) =>
  new Response(JSON.stringify({ grades }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const renderPanel = () =>
  render(
    <GradingPanel
      courseId="c1"
      submissionId="s-1"
      studentName="Ada Lovelace"
      sectionTitle="Section 2 · p-values"
      onBack={vi.fn()}
    />,
  );

describe("GradingPanel (#75)", () => {
  it("shows the grade in force and the superseded history together", async () => {
    stub(() => gradesResponse([{ ...HUMAN_GRADE, id: "g-new", score: 90 }, { ...HUMAN_GRADE, isCurrent: false }]));
    renderPanel();
    // A regrade is a dispute-relevant fact; an instructor looking at a
    // changed score needs to see what it changed from.
    await waitFor(() => screen.getByText("In force"));
    expect(screen.getByText("Superseded")).toBeTruthy();
  });

  it("never marks an AI row as in force, however recent", async () => {
    stub(() => gradesResponse([AI_GRADE, HUMAN_GRADE]));
    renderPanel();
    await waitFor(() => screen.getByText("Draft"));
    // The rule, shown rather than explained: a grade is in force only if a
    // human wrote it.
    expect(screen.getAllByText("In force")).toHaveLength(1);
  });

  it("does not save when a draft is requested", async () => {
    const fetchMock = stub((url, init) => {
      if (init?.method === "POST" && url.endsWith("/draft")) {
        return new Response(
          JSON.stringify({
            draftGradeId: "g-draft",
            score: 78,
            maxScore: 100,
            rationale: "Engaged with the question and revised after two prompts.",
            modelName: "test/model",
          }),
          { status: 201 },
        );
      }
      return gradesResponse([]);
    });
    renderPanel();
    await waitFor(() => screen.getByRole("button", { name: /Draft a grade/i }));

    fireEvent.click(screen.getByRole("button", { name: /Draft a grade/i }));
    await waitFor(() => screen.getByText(/Engaged with the question/i));

    // The draft is a proposal. Nothing was recorded as the instructor's own
    // grade, which is what "never auto-finalized" means at this layer.
    const saves = fetchMock.mock.calls.filter(
      (c) => (c[1] as RequestInit)?.method === "POST" && !String(c[0]).endsWith("/draft"),
    );
    expect(saves).toHaveLength(0);
  });

  it("copies a draft into the instructor's fields only when they ask", async () => {
    stub((url, init) => {
      if (init?.method === "POST" && url.endsWith("/draft")) {
        return new Response(
          JSON.stringify({
            draftGradeId: "g-draft",
            score: 78,
            maxScore: 100,
            rationale: "Reasoned carefully.",
            modelName: "test/model",
          }),
          { status: 201 },
        );
      }
      return gradesResponse([]);
    });
    renderPanel();
    await waitFor(() => screen.getByRole("button", { name: /Draft a grade/i }));
    fireEvent.click(screen.getByRole("button", { name: /Draft a grade/i }));
    await waitFor(() => screen.getByRole("button", { name: /Use this draft/i }));

    // Before: the instructor's own fields are untouched.
    expect((screen.getByLabelText("Score") as HTMLInputElement).value).toBe("");

    fireEvent.click(screen.getByRole("button", { name: /Use this draft/i }));
    // The moment the numbers land in the form is the moment the instructor
    // takes responsibility for them, so it is an act rather than automatic.
    expect((screen.getByLabelText("Score") as HTMLInputElement).value).toBe("78");
    expect((screen.getByLabelText("Feedback") as HTMLTextAreaElement).value).toBe(
      "Reasoned carefully.",
    );
  });

  it("records that a saved grade came from a draft", async () => {
    const fetchMock = stub((url, init) => {
      if (init?.method === "POST" && url.endsWith("/draft")) {
        return new Response(
          JSON.stringify({
            draftGradeId: "g-draft",
            score: 78,
            maxScore: 100,
            rationale: "Reasoned carefully.",
            modelName: "test/model",
          }),
          { status: 201 },
        );
      }
      if (init?.method === "POST") return gradesResponse([HUMAN_GRADE]);
      return gradesResponse([]);
    });
    renderPanel();
    await waitFor(() => screen.getByRole("button", { name: /Draft a grade/i }));
    fireEvent.click(screen.getByRole("button", { name: /Draft a grade/i }));
    await waitFor(() => screen.getByRole("button", { name: /Use this draft/i }));
    fireEvent.click(screen.getByRole("button", { name: /Use this draft/i }));
    fireEvent.click(screen.getByRole("button", { name: /Save grade/i }));

    await waitFor(() => {
      const save = fetchMock.mock.calls.find(
        (c) => (c[1] as RequestInit)?.method === "POST" && !String(c[0]).endsWith("/draft"),
      );
      expect(JSON.parse(String((save![1] as RequestInit).body)).supersedesGradeId).toBe("g-draft");
    });
  });

  it("refuses a score with no scale, and an entirely empty grade", async () => {
    const fetchMock = stub(() => gradesResponse([]));
    renderPanel();
    await waitFor(() => screen.getByLabelText("Score"));

    fireEvent.change(screen.getByLabelText("Out of"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("Score"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: /Save grade/i }));
    await waitFor(() => screen.getByText(/total greater than zero/i));

    fireEvent.change(screen.getByLabelText("Score"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Out of"), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: /Save grade/i }));
    await waitFor(() => screen.getByText(/score, written feedback, or both/i));

    expect(
      fetchMock.mock.calls.filter((c) => (c[1] as RequestInit)?.method === "POST"),
    ).toHaveLength(0);
  });

  it("accepts feedback with no score", async () => {
    const fetchMock = stub((_url, init) =>
      init?.method === "POST" ? gradesResponse([HUMAN_GRADE]) : gradesResponse([]),
    );
    renderPanel();
    await waitFor(() => screen.getByLabelText("Feedback"));
    fireEvent.change(screen.getByLabelText("Feedback"), {
      target: { value: "Written comments, no mark." },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save grade/i }));

    await waitFor(() => {
      const save = fetchMock.mock.calls.find((c) => (c[1] as RequestInit)?.method === "POST");
      expect(JSON.parse(String((save![1] as RequestInit).body)).score).toBeNull();
    });
  });

  it("says a draft is unavailable without claiming the console broke", async () => {
    stub((url, init) => {
      if (init?.method === "POST" && url.endsWith("/draft")) {
        return new Response(
          JSON.stringify({ error: "Could not draft a grade for this submission. Grade it directly." }),
          { status: 502 },
        );
      }
      return gradesResponse([]);
    });
    renderPanel();
    await waitFor(() => screen.getByRole("button", { name: /Draft a grade/i }));
    fireEvent.click(screen.getByRole("button", { name: /Draft a grade/i }));
    // An optional assistant that cannot help is an ordinary outcome; the
    // instructor grades directly, as they always could.
    // Visible alert plus the announcement -- two channels, one message.
    await waitFor(() => expect(screen.getAllByText(/Grade it directly/i).length).toBe(2));
    expect(screen.getByRole("button", { name: /Save grade/i })).toBeTruthy();
  });
});
