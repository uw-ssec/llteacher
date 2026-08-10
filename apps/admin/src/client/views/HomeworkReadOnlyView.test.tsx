import { describe, it, vi, afterEach, expect } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { HomeworkReadOnlyView } from "./HomeworkReadOnlyView";

afterEach(cleanup);

const BASE = {
  id: "hw-1",
  title: "Probability",
  description: "Intro to probability",
  dueDate: "2099-01-01T00:00:00.000Z",
  status: "active",
};

function stub(payload: unknown, status = 200) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(payload), { status })));
}

/** #172 audit (FUN-002): before this view, a TA granted can_view_solutions
 *  had nowhere to see them -- the API returned the solution and the console
 *  showed "You do not have permission to edit". */
describe("HomeworkReadOnlyView (#172 audit)", () => {
  it("renders a granted solution", async () => {
    stub({
      ...BASE,
      sections: [
        { id: "s1", title: "Sec 1", content: "body", order: 1, type: "conversation", solution: { id: "sol-1", content: "the answer is 42" } },
      ],
    });
    render(<HomeworkReadOnlyView courseId="c1" homeworkId="hw-1" onBack={vi.fn()} />);
    await waitFor(() => screen.getByText(/Probability/));
    expect(screen.getByText("the answer is 42")).toBeTruthy();
  });

  it("explains the absence when solutions were not granted", async () => {
    // The server sends solution: null for an ungranted caller; the view must
    // say why rather than silently omitting the section's most useful part.
    stub({
      ...BASE,
      sections: [
        { id: "s1", title: "Sec 1", content: "body", order: 1, type: "conversation", solution: null },
      ],
    });
    render(<HomeworkReadOnlyView courseId="c1" homeworkId="hw-1" onBack={vi.fn()} />);
    await waitFor(() => screen.getByText(/Model solutions are not shown/i));
  });

  it("offers no writes at all", async () => {
    stub({
      ...BASE,
      sections: [
        { id: "s1", title: "Sec 1", content: "body", order: 1, type: "conversation", solution: null },
      ],
    });
    render(<HomeworkReadOnlyView courseId="c1" homeworkId="hw-1" onBack={vi.fn()} />);
    await waitFor(() => screen.getByText(/Probability/));
    // The only control is "back" -- nothing that would 403.
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["All homeworks"]);
  });

  it("surfaces a load failure rather than rendering an empty shell", async () => {
    stub({}, 403);
    render(<HomeworkReadOnlyView courseId="c1" homeworkId="hw-1" onBack={vi.fn()} />);
    await waitFor(() => screen.getByRole("alert"));
  });
});
