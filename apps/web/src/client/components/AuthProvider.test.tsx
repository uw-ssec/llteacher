// @vitest-environment jsdom
// Common session/login/logout/unmount behavior is covered by
// @llteacher/ui's createAuthProvider.test.tsx -- this file only checks
// that apps/web wires the factory up (no `role` field needed here).
import { describe, it, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { AuthProvider, useAuth } from "./AuthProvider";

afterEach(cleanup);

function Probe() {
  const { isAuthenticated, loading } = useAuth();
  if (loading) return <span>loading</span>;
  return <span>{isAuthenticated ? "authed" : "anon"}</span>;
}

describe("AuthProvider / useAuth (web)", () => {
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
});
