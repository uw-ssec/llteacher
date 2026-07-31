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

  it("logout posts to /api/auth/logout", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/profile") {
        return new Response(JSON.stringify({ userId: "u1" }), { status: 200 });
      }
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => screen.getByText("authed"));
    await userEvent.click(screen.getByText("logout"));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/logout",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
