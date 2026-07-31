import { describe, it, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import App from "./App";
import { AuthProvider } from "./components/AuthProvider";

afterEach(cleanup);

function renderApp() {
  return render(
    <AuthProvider>
      <App />
    </AuthProvider>,
  );
}

describe("App auth gate", () => {
  it("shows the login prompt when signed out", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 401 })));
    renderApp();
    await waitFor(() => screen.getByText(/log in/i));
  });

  it("shows a branded 403 for a signed-in student", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ userId: "u1", role: "student" }), { status: 200 })),
    );
    renderApp();
    await waitFor(() => screen.getByText(/403/));
  });

  it("renders the admin console for a signed-in instructor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ userId: "u1", role: "instructor" }), { status: 200 })),
    );
    renderApp();
    await waitFor(() => screen.getByText(/Instructor Console/i));
  });
});
