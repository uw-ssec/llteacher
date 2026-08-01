import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuthProvider, useAuth } from "./AuthProvider";

afterEach(cleanup);

function Probe() {
  const { isAuthenticated, loading, error, role, logout } = useAuth();
  if (loading) return <span>loading</span>;
  return (
    <div>
      <span>{error ? "error" : isAuthenticated ? "authed" : "anon"}</span>
      <span>role:{role ?? "none"}</span>
      <button onClick={() => logout()}>logout</button>
    </div>
  );
}

function profileResponse(role: string | null) {
  return new Response(JSON.stringify({ userId: "u1", role }), { status: 200 });
}

describe("AuthProvider / useAuth (admin)", () => {
  it("reports authenticated with role when /api/profile resolves", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (url === "/api/profile" ? profileResponse("instructor") : new Response(null, { status: 204 }))),
    );
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => screen.getByText("authed"));
    expect(screen.getByText("role:instructor")).toBeTruthy();
  });

  it("reports anonymous when /api/profile returns 401", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 401 })));
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => screen.getByText("anon"));
    expect(screen.getByText("role:none")).toBeTruthy();
  });

  it("reports an error when /api/profile fails with a 5xx", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => screen.getByText("error"));
  });

  it("logout submits a hidden form (top-level POST navigation), not a fetch", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url === "/api/profile" ? profileResponse("instructor") : new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    // fetch()-based logout POSTs follow the server's redirect as a
    // background request -- the browser never navigates, so WorkOS's
    // session cookie is never cleared. Logout must instead submit a real
    // <form> so the browser follows the 302 as a top-level navigation.
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
});
