// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import App from "./App";
import { AuthProvider } from "./components/AuthProvider";

afterEach(cleanup);

/* #144: a render throw inside the chat column (e.g. a malformed LLM
   tool-call shape that somehow slips past packages/ui/src/generative/
   render.tsx's own runtime validation -- see render.test.tsx for that
   layer's dedicated coverage) must not white-screen the whole app. This
   file is separate from App.test.tsx specifically so this module-scoped
   vi.mock of @llteacher/ui (which makes ConversationView throw
   unconditionally) doesn't leak into every other App test in that file. */
vi.mock("@llteacher/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@llteacher/ui")>();
  return {
    ...actual,
    ConversationView: () => {
      throw new Error("boom: malformed render");
    },
  };
});

function stubBaseFetch() {
  vi.stubGlobal("CSS", { supports: () => true });
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/profile") return new Response(JSON.stringify({}), { status: 200 });
      if (url === "/api/hello") {
        return new Response(JSON.stringify({ message: "ok", ping_id: "1".repeat(8) }), { status: 200 });
      }
      if (url === "/api/student/homeworks") return new Response(JSON.stringify({ homeworks: [] }), { status: 200 });
      if (url.startsWith("/api/conversations?")) return new Response(JSON.stringify([]), { status: 200 });
      throw new Error(`unexpected fetch to ${url}`);
    }),
  );
}

describe("App error boundary (#144)", () => {
  it("contains a chat-column render throw instead of white-screening the whole app", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    stubBaseFetch();

    render(
      <MemoryRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>,
    );

    // TopNav (role="banner") still renders -- the render throw inside the
    // chat column's ErrorBoundary did not propagate up and take out the
    // rest of the app shell.
    expect(await screen.findByRole("banner")).toBeTruthy();
    // The chat column shows the boundary's recoverable fallback instead of
    // the component that threw.
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/something went wrong/i)).toBeTruthy();

    consoleError.mockRestore();
  });
});
