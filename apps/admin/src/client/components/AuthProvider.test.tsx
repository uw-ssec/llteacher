// @vitest-environment jsdom
// Common session/login/logout/unmount behavior is covered by
// @llteacher/ui's createAuthProvider.test.tsx -- this file only checks
// admin's one divergence point: parsing `role` off /api/profile.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { AuthProvider, useAuth } from "./AuthProvider";

afterEach(cleanup);

function Probe() {
  const { isAuthenticated, loading, role } = useAuth();
  if (loading) return <span>loading</span>;
  return <span>{isAuthenticated ? `authed:${role ?? "none"}` : "anon"}</span>;
}

function profileResponse(role: string | null) {
  return new Response(JSON.stringify({ userId: "u1", role }), { status: 200 });
}

describe("AuthProvider / useAuth (admin)", () => {
  it("reports the role from a successful /api/profile response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => profileResponse("instructor")));
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => screen.getByText("authed:instructor"));
  });

  it("defaults role to null when signed out", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 401 })));
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => screen.getByText("anon"));
  });

  it("defaults role to null when the response omits it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ userId: "u1" }), { status: 200 })),
    );
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => screen.getByText("authed:none"));
  });

  it("denies (null) and warns on an unrecognized role instead of trusting it through", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => profileResponse("grader")));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => screen.getByText("authed:none"));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("grader"));

    warnSpy.mockRestore();
  });
});
