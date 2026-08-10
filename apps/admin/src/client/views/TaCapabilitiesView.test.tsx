import { describe, it, vi, afterEach, expect } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { TaCapabilitiesView } from "./TaCapabilitiesView";

afterEach(cleanup);

const TA = {
  membershipId: "m-1",
  userId: "u-ta",
  displayName: "Ada Lovelace",
  email: "ada@uw.edu",
  canViewSolutions: false,
  canViewDrafts: false,
};

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("TaCapabilitiesView (#172)", () => {
  it("renders each TA with both capabilities shown as not allowed by default", async () => {
    stubFetch(() => new Response(JSON.stringify({ tas: [TA] }), { status: 200 }));
    render(<TaCapabilitiesView courseId="c1" />);
    await waitFor(() => screen.getByText("Ada Lovelace"));
    expect(screen.getAllByText("Not allowed")).toHaveLength(2);
  });

  it("shows an empty state when the course has no TAs", async () => {
    stubFetch(() => new Response(JSON.stringify({ tas: [] }), { status: 200 }));
    render(<TaCapabilitiesView courseId="c1" />);
    await waitFor(() => screen.getByText(/No teaching assistants/i));
  });

  it("surfaces a load failure instead of rendering an empty roster", async () => {
    stubFetch(() => new Response(null, { status: 500 }));
    render(<TaCapabilitiesView courseId="c1" />);
    await waitFor(() => screen.getByRole("alert"));
  });

  it("PATCHes only the toggled capability and applies the server's echoed row", async () => {
    const fetchMock = stubFetch((_url, init) => {
      if (init?.method === "PATCH") {
        return new Response(JSON.stringify({ ...TA, canViewSolutions: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ tas: [TA] }), { status: 200 });
    });
    render(<TaCapabilitiesView courseId="c1" />);
    await waitFor(() => screen.getByText("Ada Lovelace"));

    fireEvent.click(screen.getByLabelText(/Model solutions for/i));

    await waitFor(() => expect(screen.getByText("Allowed")).toBeTruthy());
    const patchCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === "PATCH");
    expect(patchCall).toBeDefined();
    // Only the toggled field is sent, so the other capability is never
    // restated (and so can't be clobbered by a stale client value).
    expect(JSON.parse(String((patchCall![1] as RequestInit).body))).toEqual({ canViewSolutions: true });
    expect(String(patchCall![0])).toBe("/api/courses/c1/tas/m-1/capabilities");
  });

  it("surfaces a save failure and leaves the previous value showing", async () => {
    stubFetch((_url, init) => {
      if (init?.method === "PATCH") return new Response(null, { status: 500 });
      return new Response(JSON.stringify({ tas: [TA] }), { status: 200 });
    });
    render(<TaCapabilitiesView courseId="c1" />);
    await waitFor(() => screen.getByText("Ada Lovelace"));

    fireEvent.click(screen.getByLabelText(/Model solutions for/i));

    // The message is rendered inline against the failing row (associated via
    // aria-errormessage) and mirrored into the live region for announcement,
    // so it legitimately appears twice in the DOM.
    await waitFor(() => expect(screen.getAllByText(/Could not update/i).length).toBeGreaterThan(0));
    expect(screen.getAllByText("Not allowed")).toHaveLength(2);
  });

  it("identifies each TA by name and email, not by a raw id", async () => {
    // #172 audit (USE-001): granting the answer key to a *named person* is
    // the whole task; a UUID made it uncompletable.
    stubFetch(() => new Response(JSON.stringify({ tas: [TA] }), { status: 200 }));
    render(<TaCapabilitiesView courseId="c1" />);
    await waitFor(() => screen.getByText("Ada Lovelace"));
    expect(screen.getByText("ada@uw.edu")).toBeTruthy();
    expect(screen.queryByText("u-ta")).toBeNull();
  });

  it("drops a malformed row instead of rendering an uncontrolled checkbox", async () => {
    // #172 audit (CMP-005): a row missing a boolean flag would otherwise
    // render checked={undefined} and PATCH a value never shown to the user.
    stubFetch(() =>
      new Response(JSON.stringify({ tas: [TA, { membershipId: "m-2", userId: "u2" }] }), {
        status: 200,
      }),
    );
    render(<TaCapabilitiesView courseId="c1" />);
    await waitFor(() => screen.getByText("Ada Lovelace"));
    expect(screen.getAllByRole("row")).toHaveLength(2); // header + one valid row
  });

  it("surfaces the server's message on a 404 rather than telling the user to retry", async () => {
    // #172 audit (USE-003): "please try again" is advice that never succeeds
    // when the TA has been removed from the course.
    stubFetch((_url, init) => {
      if (init?.method === "PATCH") {
        return new Response(JSON.stringify({ error: "TA membership not found in this course" }), {
          status: 404,
        });
      }
      return new Response(JSON.stringify({ tas: [TA] }), { status: 200 });
    });
    render(<TaCapabilitiesView courseId="c1" />);
    await waitFor(() => screen.getByText("Ada Lovelace"));
    fireEvent.click(screen.getByLabelText(/Model solutions for/i));
    await waitFor(() => expect(screen.getAllByText(/not found in this course/i).length).toBeGreaterThan(0));
  });
});
