import { describe, it, vi, afterEach, expect } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { AddInstructorView } from "./AddInstructorView";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubFetch(
  handler: (url: string, init?: RequestInit) => Response,
  instructors: unknown[] = [],
) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/platform/instructors" && (!init?.method || init.method === "GET")) {
      return new Response(JSON.stringify({ instructors }), { status: 200 });
    }
    return handler(url, init);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function fillEmail(value: string) {
  fireEvent.change(screen.getByLabelText(/email address/i), { target: { value } });
}

describe("AddInstructorView (#316)", () => {
  it("lists every platform-approved instructor with sign-in state and assigned-course count", async () => {
    stubFetch(() => { throw new Error("unexpected mutation"); }, [
      { userId: "u-signed-in", email: "ada@uw.edu", status: "signed_in", grantedAt: "2026-01-02T00:00:00Z", assignedCourseCount: 2, assignedCourses: [{ code: "STAT 311", term: "Autumn 2026" }, { code: "MATH 124", term: "Winter 2027" }] },
      { userId: "u-pending", email: "grace@uw.edu", status: "pending", grantedAt: "2026-01-03T00:00:00Z", assignedCourseCount: 0, assignedCourses: [] },
    ]);

    render(<AddInstructorView />);

    expect(await screen.findByRole("heading", { name: "All instructors" })).toBeTruthy();
    expect(screen.getByRole("rowheader", { name: "ada@uw.edu" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "Signed in" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "2" })).toBeTruthy();
    expect(screen.getByText("STAT 311")).toBeTruthy();
    expect(screen.getByText("MATH 124")).toBeTruthy();
    expect(screen.getByRole("rowheader", { name: "grace@uw.edu" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "Pending" })).toBeTruthy();
  });

  it("submits the entered email and shows a success confirmation", async () => {
    const fetchMock = stubFetch((url) => {
      expect(url).toBe("/api/platform/instructors");
      return new Response(
        JSON.stringify({ status: "granted", userId: "u-new", grantedAt: "2026-01-01T00:00:00Z" }),
        { status: 200 },
      );
    });
    render(<AddInstructorView />);

    fillEmail("new-instructor@uw.edu");
    fireEvent.click(screen.getByRole("button", { name: /grant instructor access/i }));

    await waitFor(() => screen.getByText(/They'll have instructor access/i));
    const mutationCalls = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    expect(mutationCalls).toHaveLength(1);
    const [, init] = mutationCalls[0]!;
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      email: "new-instructor@uw.edu",
    });
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => !init?.method || init.method === "GET")).toHaveLength(2));
  });

  it("clears the field after a successful grant, so the form is ready for the next email", async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({ status: "granted", userId: "u-new", grantedAt: "2026-01-01T00:00:00Z" }),
          { status: 200 },
        ),
    );
    render(<AddInstructorView />);

    fillEmail("new-instructor@uw.edu");
    fireEvent.click(screen.getByRole("button", { name: /grant instructor access/i }));

    await waitFor(() => screen.getByText(/They'll have instructor access/i));
    expect((screen.getByLabelText(/email address/i) as HTMLInputElement).value).toBe("");
  });

  it("shows the server's own message for a disallowed domain, and does not show a success line", async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({ error: 'Domain "gmail.com" is not allowed. Allowed domains: uw.edu' }),
          { status: 400 },
        ),
    );
    render(<AddInstructorView />);

    fillEmail("outsider@gmail.com");
    fireEvent.click(screen.getByRole("button", { name: /grant instructor access/i }));

    await waitFor(() => screen.getByText(/gmail\.com/));
    expect(screen.queryByText(/They'll have instructor access/i)).toBeNull();
  });

  it("shows a generic message for a super-admin-only 403 (defense in depth, should not normally be reachable)", async () => {
    stubFetch(() => new Response(JSON.stringify({ error: "Super admin access required" }), { status: 403 }));
    render(<AddInstructorView />);

    fillEmail("x@uw.edu");
    fireEvent.click(screen.getByRole("button", { name: /grant instructor access/i }));

    await waitFor(() => screen.getByText(/Super admin access required/i));
  });

  it("disables the submit button while a grant is in flight", async () => {
    let resolve!: (r: Response) => void;
    stubFetch(
      () =>
        new Promise<Response>((r) => {
          resolve = r;
        }) as unknown as Response,
    );
    render(<AddInstructorView />);

    fillEmail("new-instructor@uw.edu");
    const button = screen.getByRole("button", { name: /grant instructor access/i }) as HTMLButtonElement;
    fireEvent.click(button);

    await waitFor(() => expect(button.disabled).toBe(true));
    resolve(
      new Response(
        JSON.stringify({ status: "granted", userId: "u-new", grantedAt: "2026-01-01T00:00:00Z" }),
        { status: 200 },
      ),
    );
    await waitFor(() => screen.getByText(/They'll have instructor access/i));
    // The field is cleared on success (its own test above), so re-filling it
    // is what proves busy no longer blocks submission -- checking .disabled
    // right after resolve would be true either way (empty field or busy).
    fillEmail("another@uw.edu");
    expect(button.disabled).toBe(false);
  });

  it("does not submit an empty or blank email", () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 200 }));
    render(<AddInstructorView />);

    const button = screen.getByRole("button", { name: /grant instructor access/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    fillEmail("   ");
    expect(button.disabled).toBe(true);
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toBe(false);
  });
});
