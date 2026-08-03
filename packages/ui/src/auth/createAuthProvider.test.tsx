// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createAuthProvider } from "./createAuthProvider";

afterEach(cleanup);

const { AuthProvider, useAuth } = createAuthProvider({ defaultExtra: {} });

function Probe() {
  const { isAuthenticated, loading, error, logout } = useAuth();
  if (loading) return <span>loading</span>;
  return (
    <div>
      <span>{error ? "error" : isAuthenticated ? "authed" : "anon"}</span>
      <button onClick={() => logout()}>logout</button>
    </div>
  );
}

describe("createAuthProvider", () => {
  it("reports authenticated when /api/profile resolves", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ userId: "u1" }), { status: 200 })),
    );
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => screen.getByText("authed"));
  });

  it("reports anonymous when /api/profile returns 401", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 401 })));
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => screen.getByText("anon"));
  });

  it("reports an error (not merely anonymous) when /api/profile fails with a 5xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "nope" }), { status: 503 })),
    );
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => screen.getByText("error"));
  });

  it("reports an error when the request itself fails (network down)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => screen.getByText("error"));
  });

  it("logout submits a hidden form (top-level POST navigation), not a fetch", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url === "/api/profile"
        ? new Response(JSON.stringify({ userId: "u1" }), { status: 200 })
        : new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const submitSpy = vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(() => {});

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => screen.getByText("authed"));
    await userEvent.click(screen.getByText("logout"));

    const form = document.querySelector("form");
    expect(form).not.toBeNull();
    expect(form?.method).toBe("post");
    expect(form?.action).toMatch(/\/api\/auth\/logout$/);
    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/auth/logout",
      expect.objectContaining({ method: "POST" }),
    );

    submitSpy.mockRestore();
    form?.remove();
  });

  it("does not update state after unmount when the profile fetch resolves late", async () => {
    let resolveFetch: (r: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { unmount } = render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    unmount();
    resolveFetch(new Response(JSON.stringify({ userId: "u1" }), { status: 200 }));
    await Promise.resolve();
    await Promise.resolve();

    expect(consoleErrorSpy).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});
