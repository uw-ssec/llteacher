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
