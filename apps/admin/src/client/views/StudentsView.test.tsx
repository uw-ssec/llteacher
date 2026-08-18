/* --------------------------------------------------------------------------
   #32 / #86: the roster view.

   The behaviours under test are the ones the issue is explicit about: a
   pending person is visually distinct from an active one, dropped members
   stay visible, and the import is preview-first.
   -------------------------------------------------------------------------- */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { StudentsView } from "./StudentsView";

afterEach(cleanup);

const ACTIVE = {
  membershipId: "m-1",
  userId: "u-1",
  displayName: "Ada Lovelace",
  email: "ada@uw.edu",
  initials: "AL",
  role: "student" as const,
  status: "active" as const,
  enrolledAt: "2026-01-01T00:00:00.000Z",
  lastLoginAt: new Date(Date.now() - 3_600_000).toISOString(),
  droppedAt: null,
};
const PENDING = {
  ...ACTIVE,
  membershipId: "m-2",
  userId: "u-2",
  displayName: "",
  email: "ghopper@uw.edu",
  initials: "GH",
  status: "pending" as const,
  lastLoginAt: null,
};
const DROPPED = {
  ...ACTIVE,
  membershipId: "m-3",
  userId: "u-3",
  displayName: "Alan Turing",
  email: "aturing@uw.edu",
  status: "dropped" as const,
  droppedAt: "2026-02-01T00:00:00.000Z",
};

function stub(handler: (url: string, init: RequestInit) => Response) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init ?? {}),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

const rosterResponse = (members: unknown[]) =>
  new Response(JSON.stringify({ members, total: members.length }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const renderView = () => render(<StudentsView courseId="c1" courseTitle="STATS 311" />);

describe("StudentsView (#32)", () => {
  it("distinguishes an invited person from an active one", async () => {
    stub(() => rosterResponse([ACTIVE, PENDING]));
    renderView();
    await waitFor(() => screen.getByText("Ada Lovelace"));

    // #32's requirement, and the reason for it: "has not signed in yet" and
    // "something went wrong" look identical if the only signal is an empty
    // Last active cell.
    expect(screen.getByText("Invited")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    // A pending person has no display name until their first login; saying
    // "(no name on file)" would read as a data problem.
    expect(screen.getByText("ghopper")).toBeTruthy();
  });

  it("keeps removed people visible rather than hiding them", async () => {
    stub(() => rosterResponse([ACTIVE, DROPPED]));
    renderView();
    // A removal that leaves no trace is indistinguishable from a person who
    // was never added -- and "why is this student gone" is a question this
    // page exists to answer.
    await waitFor(() => screen.getByText("Alan Turing"));
    expect(screen.getByText("Removed")).toBeTruthy();
  });

  it("counts each status on the filter, before it is clicked", async () => {
    stub(() => rosterResponse([ACTIVE, PENDING, DROPPED]));
    renderView();
    // "Has anyone not signed in?" is answerable without clicking anything.
    await waitFor(() => screen.getByRole("button", { name: /Invited 1/ }));
    expect(screen.getByRole("button", { name: /All 3/ })).toBeTruthy();
  });

  it("filters by status and by search, and offers a way back", async () => {
    stub(() => rosterResponse([ACTIVE, PENDING]));
    renderView();
    await waitFor(() => screen.getByText("Ada Lovelace"));

    fireEvent.click(screen.getByRole("button", { name: /Invited 1/ }));
    expect(screen.queryByText("Ada Lovelace")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /All 2/ }));
    fireEvent.change(screen.getByLabelText(/Search the roster/i), {
      target: { value: "nobody" },
    });
    // An empty RESULT is a different sentence from an empty roster, and
    // offers the way out rather than looking like a broken page.
    await waitFor(() => screen.getByText(/No one matches that/i));
    fireEvent.click(screen.getByRole("button", { name: /Clear the filters/i }));
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
  });

  it("offers the import as the next action when nobody is enrolled", async () => {
    stub(() => rosterResponse([]));
    renderView();
    // The #192 lesson applied here from the start: an empty state that
    // states a fact and offers no action is a dead end.
    await waitFor(() => screen.getByText(/Nobody is enrolled/i));
    // Two: the page-header action and the empty state's own call to action.
    // Both are wanted -- the header one persists as the roster fills, and
    // the empty state must not be a dead end (#192's lesson).
    expect(screen.getAllByRole("button", { name: /Import from CSV/i }).length).toBe(2);
  });

  it("confirms before removing, and does not call the API when declined", async () => {
    const fetchMock = stub(() => rosterResponse([ACTIVE]));
    vi.stubGlobal("confirm", vi.fn(() => false));
    renderView();
    await waitFor(() => screen.getByText("Ada Lovelace"));

    fireEvent.click(screen.getByRole("button", { name: /Remove Ada Lovelace/i }));
    expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit)?.method === "DELETE")).toBe(false);
  });

  it("removes on confirm and refetches", async () => {
    let calls = 0;
    const fetchMock = stub((_url, init) => {
      if (init?.method === "DELETE") {
        return new Response(JSON.stringify({ membershipId: "m-1" }), { status: 200 });
      }
      calls += 1;
      return rosterResponse(calls === 1 ? [ACTIVE] : []);
    });
    vi.stubGlobal("confirm", vi.fn(() => true));
    renderView();
    await waitFor(() => screen.getByText("Ada Lovelace"));

    fireEvent.click(screen.getByRole("button", { name: /Remove Ada Lovelace/i }));
    await waitFor(() => expect(screen.queryByText("Ada Lovelace")).toBeNull());
    expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit)?.method === "DELETE")).toBe(true);
  });

  it("offers no Remove on an already-removed row", async () => {
    stub(() => rosterResponse([DROPPED]));
    renderView();
    await waitFor(() => screen.getByText("Alan Turing"));
    // A control that cannot work is the dead end #172 exists to remove.
    expect(screen.queryByRole("button", { name: /Remove Alan Turing/i })).toBeNull();
  });

  it("offers a retry on a server failure but not on a denial", async () => {
    stub(() => new Response(JSON.stringify({ error: "nope" }), { status: 500 }));
    const { unmount } = renderView();
    await waitFor(() => screen.getByRole("button", { name: /try again/i }));
    unmount();

    stub(() => new Response(JSON.stringify({ error: "Instructor access denied" }), { status: 403 }));
    renderView();
    // Retrying a permission outcome cannot succeed, and a button that never
    // works reads as a broken console (#191).
    await waitFor(() => screen.getByText(/not available to you/i));
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
  });
});

describe("RosterImportPanel through StudentsView (#86)", () => {
  it("previews before committing, and writes nothing until confirmed", async () => {
    const fetchMock = stub((_url, init) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { preview: boolean };
        return new Response(
          JSON.stringify({
            preview: body.preview,
            added: 1,
            restored: 0,
            failed: 1,
            rows: [
              { line: 1, email: "ada@uw.edu", name: "Ada", role: "", status: "added" },
              { line: 2, email: "bad@gmail.com", name: "", role: "", status: "disallowed_domain" },
            ],
          }),
          { status: 200 },
        );
      }
      return rosterResponse([]);
    });
    renderView();
    await waitFor(() => screen.getByText(/Nobody is enrolled/i));
    fireEvent.click(screen.getAllByRole("button", { name: /Import from CSV/i })[0]!);

    const file = new File(["email\nada@uw.edu\nbad@gmail.com\n"], "roster.csv", { type: "text/csv" });
    fireEvent.change(screen.getByLabelText(/Choose a roster CSV file/i), {
      target: { files: [file] },
    });

    // Per-row outcomes with spreadsheet line numbers, so the instructor can
    // find the row they must fix.
    await waitFor(() => screen.getByText("Row 2"));
    expect(screen.getByText("bad@gmail.com")).toBeTruthy();
    expect(screen.getAllByText(/will be added/i).length).toBeGreaterThan(0);

    const posts = () =>
      fetchMock.mock.calls.filter((c) => (c[1] as RequestInit)?.method === "POST");
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(String((posts()[0]![1] as RequestInit).body)).preview).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /Import 1 person/i }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    // Only the second call writes.
    expect(JSON.parse(String((posts()[1]![1] as RequestInit).body)).preview).toBe(false);
  });

  it("rejects a non-CSV file before reading it", async () => {
    stub(() => rosterResponse([]));
    renderView();
    await waitFor(() => screen.getByText(/Nobody is enrolled/i));
    fireEvent.click(screen.getAllByRole("button", { name: /Import from CSV/i })[0]!);

    const file = new File(["binary"], "roster.xlsx", { type: "application/vnd.ms-excel" });
    fireEvent.change(screen.getByLabelText(/Choose a roster CSV file/i), {
      target: { files: [file] },
    });
    // The accept attribute is a picker hint the OS lets you bypass.
    await waitFor(() => screen.getByText(/Choose a \.csv file/i));
  });
});

/* --------------------------------------------------------------------------
   Audit fixes: #356, #357, #358.
   -------------------------------------------------------------------------- */
describe("StudentsView audit fixes", () => {
  const INSTRUCTOR = {
    ...ACTIVE,
    membershipId: "m-instructor",
    userId: "u-instructor",
    displayName: "Anjali Chen",
    email: "achen@uw.edu",
    role: "instructor" as const,
  };

  it("offers no Remove on a membership the server refuses to remove (#357)", async () => {
    stub(() => rosterResponse([ACTIVE, INSTRUCTOR]));
    renderView();
    await waitFor(() => screen.getByText("Anjali Chen"));
    // A course with nobody who can add an instructor back is the failure the
    // server rule prevents, and this page is reachable by an instructor on
    // their OWN row -- so the button was a destructive-looking control that
    // always 409s.
    expect(screen.queryByRole("button", { name: /Remove Anjali Chen/i })).toBeNull();
    expect(screen.getByRole("button", { name: /Remove Ada Lovelace/i })).toBeTruthy();
  });

  it("announces the roster load and its result (#358)", async () => {
    stub(() => rosterResponse([ACTIVE, PENDING]));
    renderView();
    // Without this a screen-reader user got silence while the roster loaded
    // and no signal that it had arrived. `role="status"` on the visible
    // block would not fix it -- that is #204/ACC-028's unreliable pattern.
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toMatch(/2 people on this course/i),
    );
  });

  it("keeps the import result on screen after a commit (#356)", async () => {
    stub((_url, init) => {
      if (init?.method === "POST") {
        return new Response(
          JSON.stringify({
            preview: JSON.parse(String(init.body)).preview,
            added: 1,
            restored: 0,
            failed: 1,
            rows: [
              { line: 1, email: "ada@uw.edu", name: "", role: "", status: "added" },
              { line: 2, email: "bad@gmail.com", name: "", role: "", status: "disallowed_domain" },
            ],
          }),
          { status: 200 },
        );
      }
      return rosterResponse([]);
    });
    renderView();
    await waitFor(() => screen.getByText(/Nobody is enrolled/i));
    fireEvent.click(screen.getAllByRole("button", { name: /Import from CSV/i })[0]!);

    const file = new File(["email\nada@uw.edu\nbad@gmail.com\n"], "roster.csv", { type: "text/csv" });
    fireEvent.change(screen.getByLabelText(/Choose a roster CSV file/i), {
      target: { files: [file] },
    });
    await waitFor(() => screen.getByRole("button", { name: /Import 1 person/i }));
    fireEvent.click(screen.getByRole("button", { name: /Import 1 person/i }));

    // "Which of my eighty rows were skipped" is the thing the instructor
    // needs at exactly this moment; closing the panel took it away.
    await waitFor(() => screen.getByText(/Imported\./i));
    expect(screen.getByText("Row 2")).toBeTruthy();
    expect(screen.getByText("bad@gmail.com")).toBeTruthy();
    // And it is dismissable by the instructor, not by the app.
    expect(screen.getByRole("button", { name: /^Done$/ })).toBeTruthy();
  });
});
