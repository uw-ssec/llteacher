// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuthProvider, useAuth } from "./AuthProvider";

afterEach(cleanup);

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

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/profile") {
        return new Response(JSON.stringify({ userId: "u1" }), { status: 200 });
      }
      return new Response(null, { status: 204 });
    }),
  );
});

describe("AuthProvider / useAuth", () => {
  it("reports authenticated when /api/profile resolves", async () => {
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => screen.getByText("authed"));
  });

  it("reports anonymous when /api/profile returns 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );
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
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/profile") {
        return new Response(JSON.stringify({ userId: "u1" }), { status: 200 });
      }
      return new Response(null, { status: 204 });
    });
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
