import { describe, it, vi, afterEach, expect } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import App from "./App";
import { AuthProvider } from "./components/AuthProvider";

afterEach(cleanup);

function renderApp() {
  return render(
    <AuthProvider>
      <App />
    </AuthProvider>,
  );
}

describe("App auth gate", () => {
  it("shows the login prompt when signed out", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 401 })));
    renderApp();
    await waitFor(() => screen.getByText(/log in/i));
  });

  it("shows a branded 403 for a signed-in student", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ userId: "u1", role: "student" }), { status: 200 })),
    );
    renderApp();
    await waitFor(() => screen.getByText(/403/));
  });

  it("renders the admin console for a signed-in instructor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ userId: "u1", role: "instructor" }), { status: 200 })),
    );
    renderApp();
    await waitFor(() => screen.getByText(/Instructor Console/i));
  });
});

describe("Submissions sidebar shortcut", () => {
  it("navigates using the real homework list, not the HOMEWORKS fixture's non-UUID ids", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/profile")) {
        return new Response(
          JSON.stringify({ userId: "u1", role: "instructor", courses: [{ id: "course-real-uuid", title: "STATS 311" }] }),
          { status: 200 },
        );
      }
      if (url === "/api/courses/course-real-uuid/homeworks") {
        return new Response(
          JSON.stringify({
            homeworks: [
              { id: "hw-real-uuid-1", title: "HW A", description: "", dueDate: "2026-01-01T00:00:00.000Z", llmConfigId: null, status: "draft", sectionCount: 1 },
              { id: "hw-real-uuid-2", title: "HW B", description: "", dueDate: "2026-02-01T00:00:00.000Z", llmConfigId: null, status: "active", sectionCount: 2 },
            ],
          }),
          { status: 200 },
        );
      }
      if (url === "/api/courses/course-real-uuid/homeworks/hw-real-uuid-2/submissions") {
        return new Response(
          JSON.stringify({
            homeworkId: "hw-real-uuid-2", homeworkTitle: "HW B", homeworkDueDate: "2026-02-01T00:00:00.000Z",
            sectionHeaders: [], students: [], missingSectionWarnings: [],
            aggregateStats: { totalStudents: 0, activeStudents: 0, inactiveStudents: 0, totalSubmissions: 0, submissionRate: 0 },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderApp();
    await waitFor(() => screen.getByText(/Instructor Console/i));

    const submissionsLabel = screen.getAllByText("Submissions").find((el) => el.closest("button"));
    fireEvent.click(submissionsLabel!.closest("button")!);

    // Picks the "active" homework from the real list (hw-real-uuid-2 /
    // "HW B"), not HOMEWORKS[0]'s fixture id -- only reachable if the
    // submissions fetch used the real-list-derived id, since a fixture id
    // isn't one of the two URLs mocked above and the request would fall
    // through to the catch-all {} response, which SubmissionsView can't
    // render "HW B" from.
    await waitFor(() => screen.getByText("HW B"));
    expect(fetchMock).toHaveBeenCalled();
  });
});

/** #172: a TA belongs in this console -- they have grading work to do -- but
 *  must not be shown authoring affordances whose requests the server
 *  refuses. Gating is per course, from /api/profile's `courses[].role`, not
 *  from the priority-ranked top-level `role`. */
describe("TA console gating (#172)", () => {
  function stubProfile(courses: unknown[], topLevelRole = "instructor") {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/profile")) {
          return new Response(
            JSON.stringify({ userId: "u1", role: topLevelRole, courses }),
            { status: 200 },
          );
        }
        if (url.includes("/homeworks")) {
          return new Response(JSON.stringify({ homeworks: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({ tas: [] }), { status: 200 });
      }),
    );
  }

  it("admits a TA to the console", async () => {
    stubProfile(
      [{ id: "c1", title: "STATS 311", role: "ta", canViewSolutions: false, canViewDrafts: false }],
      "ta",
    );
    renderApp();
    await waitFor(() => screen.getByText(/Instructor Console/i));
  });

  it("hides the New homework quick action from a TA", async () => {
    stubProfile(
      [{ id: "c1", title: "STATS 311", role: "ta", canViewSolutions: false, canViewDrafts: false }],
      "ta",
    );
    renderApp();
    await waitFor(() => screen.getByText(/Instructor Console/i));
    expect(screen.queryByText(/New homework/i)).toBeNull();
  });

  it("shows the New homework quick action to an instructor", async () => {
    stubProfile([
      { id: "c1", title: "STATS 311", role: "instructor", canViewSolutions: true, canViewDrafts: true },
    ]);
    renderApp();
    await waitFor(() => screen.getAllByText(/New homework/i));
  });

  /* The case the top-level primary role gets wrong: instructor in one course,
     TA in the active one. Priority ranking reports "instructor", so gating on
     it would show authoring controls the server refuses for this course. */
  it("gates on the active course, not the priority-ranked primary role", async () => {
    stubProfile(
      [
        { id: "c1", title: "STATS 311", role: "ta", canViewSolutions: false, canViewDrafts: false },
        { id: "c2", title: "STATS 390", role: "instructor", canViewSolutions: true, canViewDrafts: true },
      ],
      "instructor",
    );
    renderApp();
    await waitFor(() => screen.getByText(/Instructor Console/i));
    expect(screen.queryByText(/New homework/i)).toBeNull();
  });

  /* Version skew: an older apps/web returns courses without role/capability
     fields. Those entries must still be usable (falling back to the primary
     role) rather than dropped, which would render "No course found". */
  it("falls back to the primary role for a pre-#172 profile payload", async () => {
    stubProfile([{ id: "c1", title: "STATS 311" }]);
    renderApp();
    await waitFor(() => screen.getAllByText(/New homework/i));
  });
});
