import { describe, it, vi, afterEach, expect } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { TaCapabilitiesView } from "./TaCapabilitiesView";

afterEach(cleanup);

const TA = { membershipId: "m-1", userId: "u-ta", canViewSolutions: false, canViewDrafts: false };

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
    await waitFor(() => screen.getByText("u-ta"));
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
    await waitFor(() => screen.getByText("u-ta"));

    fireEvent.click(screen.getByLabelText(/Allow model solutions/i));

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
    await waitFor(() => screen.getByText("u-ta"));

    fireEvent.click(screen.getByLabelText(/Allow model solutions/i));

    await waitFor(() => screen.getByRole("alert"));
    expect(screen.getAllByText("Not allowed")).toHaveLength(2);
  });

  it("renders the toggles read-only for a caller who cannot author", async () => {
    stubFetch(() => new Response(JSON.stringify({ tas: [TA] }), { status: 200 }));
    render(<TaCapabilitiesView courseId="c1" canAuthor={false} />);
    await waitFor(() => screen.getByText("u-ta"));
    // Plain DOM property rather than a jest-dom matcher -- this workspace
    // doesn't register @testing-library/jest-dom.
    expect((screen.getByLabelText(/Allow model solutions/i) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText(/Allow unreleased homeworks/i) as HTMLInputElement).disabled).toBe(true);
  });
});
