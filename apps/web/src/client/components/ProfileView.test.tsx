// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProfileView } from "./ProfileView";
import { AuthProvider } from "./AuthProvider";

afterEach(cleanup);

const PROFILE = {
  userId: "u1",
  email: "cdcore@uw.edu",
  displayName: "Cordero",
  role: "instructor",
  courseCount: 2,
  instructorStats: { homeworksCreated: 3 },
};

function renderProfileView() {
  return render(
    <AuthProvider>
      <ProfileView />
    </AuthProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(PROFILE), { status: 200 })),
  );
});

describe("ProfileView", () => {
  it("renders decrypted profile fields and instructor stats", async () => {
    renderProfileView();
    await waitFor(() => screen.getByText("cdcore@uw.edu"));
    expect(screen.getByText("Role: instructor")).toBeTruthy();
    expect(screen.getByText(/Homeworks created: 3/)).toBeTruthy();
  });

  it("renders student stats including completedSections", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              userId: "u2",
              email: "student@uw.edu",
              displayName: null,
              role: "student",
              courseCount: 1,
              studentStats: { submissionsCount: 4, completedSections: 2 },
            }),
            { status: 200 },
          ),
      ),
    );
    renderProfileView();
    await waitFor(() => screen.getByText(/Completed sections: 2/));
  });

  it("shows a login affordance (not a dead error message) for a signed-out visitor", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 401 })));
    renderProfileView();
    await waitFor(() => screen.getByRole("button", { name: /log in/i }));
    expect(screen.queryByText(/unable to load/i)).toBeNull();
  });

  it("shows a fallback message when the user is authenticated but the profile fetch itself fails", async () => {
    // First call is AuthProvider's own session check (succeeds); the
    // second is ProfileView's profile fetch (fails) -- a transient failure
    // distinct from being signed out.
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        callCount++;
        if (callCount === 1) return new Response(JSON.stringify(PROFILE), { status: 200 });
        return new Response(null, { status: 500 });
      }),
    );
    renderProfileView();
    await waitFor(() => screen.getByText(/unable to load/i));
  });

  it("shows a dismissible error when saving fails, and reloads the profile on success", async () => {
    const fetchMock = vi.fn(async (_url: string, opts?: RequestInit) => {
      if (opts?.method === "PATCH") return new Response(null, { status: 500 });
      return new Response(JSON.stringify(PROFILE), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderProfileView();
    await waitFor(() => screen.getByText("cdcore@uw.edu"));

    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => screen.getByRole("alert"));
    expect(screen.getByRole("alert").textContent).toMatch(/failed to save/i);

    await userEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not update state after unmount when the profile fetch resolves late", async () => {
    let resolveSecondCall: (r: Response) => void = () => {};
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        callCount++;
        if (callCount === 1) return new Response(JSON.stringify(PROFILE), { status: 200 });
        return new Promise<Response>((resolve) => {
          resolveSecondCall = resolve;
        });
      }),
    );
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { unmount } = renderProfileView();
    await waitFor(() => expect(callCount).toBeGreaterThanOrEqual(2));
    unmount();
    resolveSecondCall(new Response(JSON.stringify(PROFILE), { status: 200 }));
    await Promise.resolve();
    await Promise.resolve();

    expect(consoleErrorSpy).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});
