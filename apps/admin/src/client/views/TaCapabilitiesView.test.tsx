import { describe, it, vi, afterEach, expect } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent, within } from "@testing-library/react";
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
    render(<TaCapabilitiesView courseId="c1" courseTitle="STATS 311" />);
    await waitFor(() => screen.getByText("Ada Lovelace"));
    expect(screen.getAllByText("Not allowed")).toHaveLength(2);
  });

  it("shows an empty state when the course has no TAs", async () => {
    stubFetch(() => new Response(JSON.stringify({ tas: [] }), { status: 200 }));
    render(<TaCapabilitiesView courseId="c1" courseTitle="STATS 311" />);
    await waitFor(() => screen.getByText(/No teaching assistants/i));
  });

  it("surfaces a load failure instead of rendering an empty roster", async () => {
    stubFetch(() => new Response(null, { status: 500 }));
    render(<TaCapabilitiesView courseId="c1" courseTitle="STATS 311" />);
    await waitFor(() => screen.getByRole("alert"));
  });

  it("PATCHes only the toggled capability and applies the server's echoed row", async () => {
    const fetchMock = stubFetch((_url, init) => {
      if (init?.method === "PATCH") {
        return new Response(JSON.stringify({ ...TA, canViewSolutions: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ tas: [TA] }), { status: 200 });
    });
    render(<TaCapabilitiesView courseId="c1" courseTitle="STATS 311" />);
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
    render(<TaCapabilitiesView courseId="c1" courseTitle="STATS 311" />);
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
    render(<TaCapabilitiesView courseId="c1" courseTitle="STATS 311" />);
    await waitFor(() => screen.getByText("Ada Lovelace"));
    expect(screen.getByText("ada@uw.edu")).toBeTruthy();
    expect(screen.queryByText("u-ta")).toBeNull();
  });

  it("drops a malformed row instead of rendering an uncontrolled checkbox", async () => {
    // #172 audit: a row missing a boolean flag would otherwise
    // render checked={undefined} and PATCH a value never shown to the user.
    stubFetch(() =>
      new Response(JSON.stringify({ tas: [TA, { membershipId: "m-2", userId: "u2" }] }), {
        status: 200,
      }),
    );
    render(<TaCapabilitiesView courseId="c1" courseTitle="STATS 311" />);
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
    render(<TaCapabilitiesView courseId="c1" courseTitle="STATS 311" />);
    await waitFor(() => screen.getByText("Ada Lovelace"));
    fireEvent.click(screen.getByLabelText(/Model solutions for/i));
    await waitFor(() => expect(screen.getAllByText(/not found in this course/i).length).toBeGreaterThan(0));
  });

  /** #172 re-audit (USE-010): a 404 save triggers load() to drop the stale
   *  row. The error message used to live inside the table body, so the
   *  refetch unmounted the only explanation the instructor ever got -- and
   *  since the refetched roster no longer contains that TA, it never came
   *  back. The toggle just reverted, silently. */
  it("keeps the 404 explanation on screen after the refetch removes the row", async () => {
    let listCall = 0;
    stubFetch((_url, init) => {
      if (init?.method === "PATCH") {
        return new Response(JSON.stringify({ error: "TA membership not found in this course" }), {
          status: 404,
        });
      }
      // First load has the TA; the refetch reflects that they are gone.
      listCall += 1;
      return new Response(JSON.stringify({ tas: listCall === 1 ? [TA] : [] }), { status: 200 });
    });
    render(<TaCapabilitiesView courseId="c1" courseTitle="STATS 311" />);
    await waitFor(() => screen.getByText("Ada Lovelace"));

    fireEvent.click(screen.getByLabelText(/Model solutions for/i));

    // The row is gone (empty roster) ...
    await waitFor(() => screen.getByText(/No teaching assistants/i));
    // ... and the reason it went is still on screen VISIBLY. Asserted
    // through role="alert" rather than by text: the polite live region
    // mirrors every message too, but it is .admin-visually-hidden, so a
    // plain text query passes even with no visible explanation at all --
    // which is exactly the state this test exists to reject.
    expect(within(screen.getByRole("alert")).getByText(/not found in this course/i)).toBeTruthy();
  });

  /** #172 re-audit (REL-012): the echo used to be spread over the local row
   *  (`parseTa({ ...ta, ...response })`), which meant an empty or
   *  wrong-membership response could not be rejected -- every required field
   *  was already supplied by `ta`, so the UI re-rendered the OLD value and
   *  announced success. */
  it("rejects a PATCH echo for a different membership instead of applying it", async () => {
    stubFetch((_url, init) => {
      if (init?.method === "PATCH") {
        // Right shape, wrong row.
        return new Response(
          JSON.stringify({ membershipId: "m-999", userId: "u-other", canViewSolutions: true, canViewDrafts: true }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ tas: [TA] }), { status: 200 });
    });
    render(<TaCapabilitiesView courseId="c1" courseTitle="STATS 311" />);
    await waitFor(() => screen.getByText("Ada Lovelace"));

    fireEvent.click(screen.getByLabelText(/Model solutions for/i));

    await waitFor(() => expect(screen.getAllByText(/unexpected response/i).length).toBeGreaterThan(0));
    // Crucially: the other row's values were NOT written onto this TA.
    expect(screen.getAllByText("Not allowed")).toHaveLength(2);
  });

  it("rejects an empty PATCH echo rather than reporting a save that did not happen", async () => {
    stubFetch((_url, init) => {
      if (init?.method === "PATCH") return new Response(JSON.stringify({}), { status: 200 });
      return new Response(JSON.stringify({ tas: [TA] }), { status: 200 });
    });
    render(<TaCapabilitiesView courseId="c1" courseTitle="STATS 311" />);
    await waitFor(() => screen.getByText("Ada Lovelace"));

    fireEvent.click(screen.getByLabelText(/Model solutions for/i));

    await waitFor(() => expect(screen.getAllByText(/unexpected response/i).length).toBeGreaterThan(0));
    expect(screen.getAllByText("Not allowed")).toHaveLength(2);
  });

  /** #172 re-audit (REL-015): savingIds keyed by membership alone made the
   *  two capabilities on one row share a lock -- toggling Solutions blocked
   *  Drafts, and showed "Saving..." under both. */
  it("tracks saving state per capability, not per row", async () => {
    let releasePatch: (() => void) | undefined;
    stubFetch((_url, init) => {
      if (init?.method === "PATCH") {
        // Never resolves during the assertions below.
        return new Promise<Response>((resolve) => {
          releasePatch = () => resolve(new Response(JSON.stringify({ ...TA, canViewSolutions: true }), { status: 200 }));
        }) as unknown as Response;
      }
      return new Response(JSON.stringify({ tas: [TA] }), { status: 200 });
    });
    render(<TaCapabilitiesView courseId="c1" courseTitle="STATS 311" />);
    await waitFor(() => screen.getByText("Ada Lovelace"));

    fireEvent.click(screen.getByLabelText(/Model solutions for/i));

    // Exactly one cell reports saving; the other still shows its value and
    // remains operable.
    await waitFor(() => expect(screen.getAllByText("Saving…")).toHaveLength(1));
    expect(screen.getAllByText("Not allowed")).toHaveLength(1);

    releasePatch?.();
  });

  /** #185 (USE-023): this page grants the answer key and used to name no
   *  course at all, while the only course string in the chrome was a
   *  hardcoded literal. */
  it("names the active course in the header", async () => {
    stubFetch(() => new Response(JSON.stringify({ tas: [TA] }), { status: 200 }));
    render(<TaCapabilitiesView courseId="c1" courseTitle="STATS 390" />);
    await waitFor(() => screen.getByText("Ada Lovelace"));
    expect(screen.getByRole("heading", { name: /STATS 390/ })).toBeTruthy();
  });

  /** #194 (ACC-022): savingIds was re-keyed per field for REL-015; saveError
   *  was not, so a failure on one capability marked the OTHER checkbox
   *  aria-invalid and pointed it at the wrong error. A screen-reader user
   *  told the drafts grant failed would "retry" it and revoke a working one. */
  it("marks only the failing capability invalid, not the whole row", async () => {
    stubFetch((_url, init) => {
      if (init?.method === "PATCH") return new Response(null, { status: 500 });
      return new Response(JSON.stringify({ tas: [TA] }), { status: 200 });
    });
    render(<TaCapabilitiesView courseId="c1" courseTitle="STATS 311" />);
    await waitFor(() => screen.getByText("Ada Lovelace"));

    const solutions = screen.getByLabelText(/Model solutions for/i);
    fireEvent.click(solutions);
    await waitFor(() => expect(screen.getAllByText(/Could not update/i).length).toBeGreaterThan(0));

    expect(solutions.getAttribute("aria-invalid")).toBe("true");
    // The capability that did NOT fail must carry no error association.
    const drafts = screen.getByLabelText(/Unreleased homeworks for/i);
    expect(drafts.getAttribute("aria-invalid")).toBeNull();
    expect(drafts.getAttribute("aria-errormessage")).toBeNull();
    expect(drafts.getAttribute("aria-describedby")).toBeNull();
  });

  it("associates the error with the failing checkbox by a resolvable id", async () => {
    stubFetch((_url, init) => {
      if (init?.method === "PATCH") return new Response(null, { status: 500 });
      return new Response(JSON.stringify({ tas: [TA] }), { status: 200 });
    });
    render(<TaCapabilitiesView courseId="c1" courseTitle="STATS 311" />);
    await waitFor(() => screen.getByText("Ada Lovelace"));
    fireEvent.click(screen.getByLabelText(/Model solutions for/i));
    await waitFor(() => expect(screen.getAllByText(/Could not update/i).length).toBeGreaterThan(0));

    const solutions = screen.getByLabelText(/Model solutions for/i);
    const id = solutions.getAttribute("aria-errormessage");
    expect(id).toBeTruthy();
    // #204 (ACC-023): describedby carries the same id, because VoiceOver
    // does not implement aria-errormessage at all.
    expect(solutions.getAttribute("aria-describedby")).toBe(id);
    expect(document.getElementById(id!)?.textContent).toMatch(/Could not update/i);
  });

  /** #195 (ACC-021): Voice Control and Dragon match on the accessible name.
   *  A name omitting the visible word left the page's only control type
   *  unaddressable by voice. */
  it("includes the visible state text in the accessible name", async () => {
    stubFetch(() => new Response(JSON.stringify({ tas: [TA] }), { status: 200 }));
    render(<TaCapabilitiesView courseId="c1" courseTitle="STATS 311" />);
    await waitFor(() => screen.getByText("Ada Lovelace"));
    // Visible text is "Not allowed"; the accessible name must contain it.
    expect(screen.getByLabelText(/^Not allowed — Model solutions for Ada Lovelace$/)).toBeTruthy();
  });

  /** #189 (USE-028): the server orders by ciphertext, which is stable but
   *  not alphabetical; the readable order can only be produced here. */
  it("sorts the roster by the name the instructor reads", async () => {
    const zoe = { ...TA, membershipId: "m-z", userId: "u-z", displayName: "Zoe Adams", email: "zoe@uw.edu" };
    const bob = { ...TA, membershipId: "m-b", userId: "u-b", displayName: "Bob Zeal", email: "bob@uw.edu" };
    stubFetch(() => new Response(JSON.stringify({ tas: [zoe, bob, TA] }), { status: 200 }));
    render(<TaCapabilitiesView courseId="c1" courseTitle="STATS 311" />);
    await waitFor(() => screen.getByText("Zoe Adams"));
    const names = screen.getAllByRole("rowheader").map((th) => th.textContent);
    expect(names[0]).toContain("Ada Lovelace");
    expect(names[1]).toContain("Bob Zeal");
    expect(names[2]).toContain("Zoe Adams");
  });
});
