/* --------------------------------------------------------------------------
   #91: the export view, and the audit fix #359.

   The interesting behaviours are the ones that keep an instructor out of a
   state the server would refuse, and the one the audit found: a failed
   roster load and an empty course are different facts and must not look the
   same.
   -------------------------------------------------------------------------- */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { ExportView } from "./ExportView";

afterEach(cleanup);

const MEMBER = {
  membershipId: "m-1",
  userId: "u-1",
  displayName: "Ada Lovelace",
  email: "ada@uw.edu",
  initials: "AL",
  role: "student" as const,
  status: "active" as const,
  enrolledAt: "2026-01-01T00:00:00.000Z",
  lastLoginAt: null,
  droppedAt: null,
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

const renderView = () => render(<ExportView courseId="c1" courseTitle="STATS 311" />);

describe("ExportView (#91)", () => {
  it("offers the course's students for a per-student export", async () => {
    stub(() => rosterResponse([MEMBER]));
    renderView();
    // The grade-dispute case: one student's records, not the class's.
    await waitFor(() => screen.getByRole("option", { name: "Ada Lovelace" }));
  });

  it("distinguishes a failed roster load from an empty course (#359)", async () => {
    stub(() => new Response(JSON.stringify({ error: "boom" }), { status: 500 }));
    const { unmount } = renderView();
    // Silently rendering an empty list told an instructor their course had
    // no students, or that per-student export was unavailable.
    await waitFor(() => screen.getByText(/student list could not be loaded/i));
    // The whole-course export still works, so the page must not be replaced
    // by a full-page error.
    expect(screen.getByRole("button", { name: /Download/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
    unmount();

    stub(() => rosterResponse([]));
    renderView();
    await waitFor(() => screen.getByText(/Nobody is enrolled in this course yet/i));
  });

  it("does not offer CSV for transcripts, and says why", async () => {
    stub(() => rosterResponse([MEMBER]));
    renderView();
    await waitFor(() => screen.getByRole("option", { name: "Ada Lovelace" }));

    fireEvent.click(screen.getByRole("radio", { name: /Transcripts/i }));
    const csv = screen.getByRole("radio", { name: /CSV/i }) as HTMLInputElement;
    // Shown disabled with the reason rather than hidden: an instructor who
    // expected a spreadsheet should learn why there isn't one.
    expect(csv.disabled).toBe(true);
    expect(screen.getByText(/a conversation is not a table/i)).toBeTruthy();
    // And the selection is corrected, so the form cannot submit a shape the
    // server refuses.
    expect((screen.getByRole("radio", { name: /JSON/i }) as HTMLInputElement).checked).toBe(true);
  });

  it("warns that a downloaded file leaves the platform's control", async () => {
    stub(() => rosterResponse([MEMBER]));
    renderView();
    // The person who needs this is the one about to click, not a reader of
    // the data-flow document.
    await waitFor(() => screen.getByText(/no longer covered by this platform/i));
  });

  it("reports a failed export without claiming a file was produced", async () => {
    stub((url, init) => {
      if (init?.method === "POST" && url.includes("/exports")) {
        return new Response(JSON.stringify({ error: "Could not build that export." }), {
          status: 503,
        });
      }
      return rosterResponse([MEMBER]);
    });
    renderView();
    await waitFor(() => screen.getByRole("button", { name: /Download/i }));
    fireEvent.click(screen.getByRole("button", { name: /Download/i }));
    // Visible alert plus the announcement -- two channels, one message.
    await waitFor(() =>
      expect(screen.getAllByText(/Could not build that export/i).length).toBe(2),
    );
  });
});
