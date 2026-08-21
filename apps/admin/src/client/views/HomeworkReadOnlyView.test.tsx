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
    expect(screen.getByRole("heading", { level: 1 })).toBeTruthy();
    await waitFor(() => screen.getByRole("alert"));
    expect(screen.getByRole("button", { name: /All homeworks/i })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 })).toBeTruthy();
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
    stub({}, 500);
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

/* --------------------------------------------------------------------------
   #191 (#172 re-audit, USE-027): three load outcomes, not one boolean.

   The failure that mattered: an instructor hides a homework while a TA has
   the list open. The TA clicks it, the server 404s deliberately, and the
   console said "Failed to load this homework." with no retry and no reason.
   The honest reading of that screen is "the console is broken", so the TA
   files an outage for a system doing exactly what it was told to.
   -------------------------------------------------------------------------- */
describe("HomeworkReadOnlyView load states (#191)", () => {
  function renderView() {
    render(
      <HomeworkReadOnlyView
        courseId="c1"
        homeworkId="hw-1"
        onBack={vi.fn()}
        canViewSolutions={false}
      />,
    );
  }

  for (const status of [403, 404]) {
    it(`treats ${status} as a permission outcome with no retry`, async () => {
      stub({}, status);
      renderView();
      await waitFor(() => screen.getByText(/not available to you/i));
      expect(screen.getByText(/withdrawn from release/i)).toBeTruthy();
      // No Try again: retrying a permission outcome cannot succeed, and a
      // button that never works reads as a broken console.
      expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
      // Not an alert either -- this is the page's content, not an
      // interruption. AdminNotice reserves role="alert" for the error tone.
      expect(screen.queryByRole("alert")).toBeNull();
    });
  }

  it("treats 5xx as a failure and offers a retry that refetches", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 500 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...BASE, sections: [] }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    renderView();

    const retry = await screen.findByRole("button", { name: /try again/i });
    expect(screen.getByText(/didn't load/i)).toBeTruthy();
    retry.click();
    // The retry is real: the second response renders, so the button
    // re-issued the request rather than only clearing the error.
    await waitFor(() => screen.getByText(/Probability/));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports a 200 whose body does not parse as a failure, not a denial", async () => {
    // Deploy skew, not permissions -- the caller may well be entitled to
    // this homework, so the retry stays on offer.
    stub({ nonsense: true });
    renderView();
    await waitFor(() => screen.getByText(/didn't load/i));
    expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
  });

  it("names a timeout as a timeout and offers a retry", async () => {
    vi.useFakeTimers();
    // Never settles on its own; only the 15s timeout can end it.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
          }),
      ),
    );
    renderView();
    await vi.advanceTimersByTimeAsync(15_000);
    vi.useRealTimers();
    await waitFor(() => screen.getByText(/Loading this homework timed out/i));
    expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
  });

  it("stays silent when the view is torn down mid-flight", async () => {
    // #202 (MNT-032): the lifecycle abort is a genuine abort on the request,
    // not a flag read after it settles -- so nothing renders, and nothing
    // flashes an error on the way out.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
          }),
      ),
    );
    const view = render(
      <HomeworkReadOnlyView
        courseId="c1"
        homeworkId="hw-1"
        onBack={vi.fn()}
        canViewSolutions={false}
      />,
    );
    view.unmount();
    await Promise.resolve();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
