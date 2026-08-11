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
    render(
      <HomeworkReadOnlyView
        courseId="c1"
        homeworkId="hw-1"
        onBack={vi.fn()}
        canViewSolutions
      />,
    );
    await waitFor(() => screen.getByText(/Probability/));
    expect(screen.getByText("the answer is 42")).toBeTruthy();
  });

  /** #172 re-audit (FUN-106): "no solutions in the payload" has two causes
   *  that need opposite sentences -- the caller wasn't granted them, or the
   *  author hasn't written any. The view cannot tell them apart from the
   *  payload, so it takes the grant as a prop. */
  it("distinguishes 'not granted' from 'none written yet'", async () => {
    const noSolutions = {
      ...BASE,
      sections: [
        { id: "s1", title: "Sec 1", content: "body", order: 1, type: "conversation", solution: null },
      ],
    };

    stub(noSolutions);
    const ungranted = render(
      <HomeworkReadOnlyView courseId="c1" homeworkId="hw-1" onBack={vi.fn()} canViewSolutions={false} />,
    );
    await waitFor(() => screen.getByText(/Model solutions are not shown/i));
    expect(screen.queryByText(/have been written/i)).toBeNull();
    ungranted.unmount();

    stub(noSolutions);
    render(
      <HomeworkReadOnlyView courseId="c1" homeworkId="hw-1" onBack={vi.fn()} canViewSolutions />,
    );
    // A granted TA must NOT be told their permissions are the reason.
    await waitFor(() => screen.getByText(/No model solutions have been written/i));
    expect(screen.queryByText(/Model solutions are not shown/i)).toBeNull();
  });

  /** #172 re-audit (ACC-009): the heading and the way out render in every
   *  state. The earlier early-returns dropped both on load and on error. */
  it("keeps a heading and a back link while loading and after a failure", async () => {
    stub({}, 500);
    render(
      <HomeworkReadOnlyView courseId="c1" homeworkId="hw-1" onBack={vi.fn()} canViewSolutions={false} />,
    );
    // Present immediately, before the fetch settles.
    expect(screen.getByRole("button", { name: /All homeworks/i })).toBeTruthy();
    expect(screen.getByRole("heading")).toBeTruthy();
    await waitFor(() => screen.getByRole("alert"));
    expect(screen.getByRole("button", { name: /All homeworks/i })).toBeTruthy();
    expect(screen.getByRole("heading")).toBeTruthy();
  });

  /** #172 re-audit (FLX-005): an unrecognized status must not be rendered as
   *  "active" -- this view exists largely to show unreleased homeworks. */
  it("renders no status badge when the status is unrecognized", async () => {
    stub({
      ...BASE,
      status: "not-a-real-status",
      sections: [
        { id: "s1", title: "Sec 1", content: "body", order: 1, type: "conversation", solution: null },
      ],
    });
    render(
      <HomeworkReadOnlyView courseId="c1" homeworkId="hw-1" onBack={vi.fn()} canViewSolutions={false} />,
    );
    await waitFor(() => screen.getByText(/Probability/));
    expect(screen.queryByText("active")).toBeNull();
    expect(screen.queryByText("not-a-real-status")).toBeNull();
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
    render(
      <HomeworkReadOnlyView
        courseId="c1"
        homeworkId="hw-1"
        onBack={vi.fn()}
        canViewSolutions={false}
      />,
    );
    await waitFor(() => screen.getByText(/Model solutions are not shown/i));
  });

  it("offers no writes at all", async () => {
    stub({
      ...BASE,
      sections: [
        { id: "s1", title: "Sec 1", content: "body", order: 1, type: "conversation", solution: null },
      ],
    });
    render(
      <HomeworkReadOnlyView
        courseId="c1"
        homeworkId="hw-1"
        onBack={vi.fn()}
        canViewSolutions={false}
      />,
    );
    await waitFor(() => screen.getByText(/Probability/));
    // The only control is "back" -- nothing that would 403.
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["All homeworks"]);
  });

  it("surfaces a load failure rather than rendering an empty shell", async () => {
    stub({}, 403);
    render(
      <HomeworkReadOnlyView
        courseId="c1"
        homeworkId="hw-1"
        onBack={vi.fn()}
        canViewSolutions={false}
      />,
    );
    await waitFor(() => screen.getByRole("alert"));
  });
});
