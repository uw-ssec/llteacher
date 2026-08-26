// @vitest-environment jsdom
/* --------------------------------------------------------------------------
   #277: streamed re-render cost on the two chat surfaces.

   Lives in its own file because it `vi.mock`s `@ai-sdk/react` wholesale to
   capture the options App passes to `useChat`, and vi.mock is file-scoped --
   doing it inside App.test.tsx would replace the real hook for all ~90 tests
   there, every one of which depends on it behaving normally.

   What this pins is narrow and deliberate: the throttle knob is PASSED. The
   issue's finding was not that the value was wrong, it was that the SDK's
   own re-render throttle was never used at all, so `useChat` re-rendered
   App once per streamed chunk -- a rate set by the model's token stream
   rather than by anything the UI needs -- and on each of those renders App
   rebuilt BOTH surfaces' message lists, including the one off screen.

   The memoization half of #277 is not asserted here. A test that "the list
   was not rebuilt" can only be written by reaching into module-private
   `buildMessageData` or by counting renders, and both couple the suite to
   the component's internal shape hard enough that #302's planned extraction
   would break them for no correctness reason. Typecheck plus App.test.tsx's
   existing rendering assertions cover that the memoized values are still
   correct; this file covers the knob that was silently absent.
   -------------------------------------------------------------------------- */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";

const useChatCalls: Record<string, unknown>[] = [];

vi.mock("@ai-sdk/react", () => ({
  useChat: (opts: Record<string, unknown>) => {
    useChatCalls.push(opts);
    return {
      messages: [],
      sendMessage: vi.fn(),
      status: "ready",
      error: undefined,
      stop: vi.fn(),
      setMessages: vi.fn(),
      regenerate: vi.fn(),
    };
  },
}));

beforeEach(() => {
  useChatCalls.length = 0;
  vi.stubGlobal("CSS", { supports: () => true });
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/profile") return new Response(JSON.stringify({}), { status: 200 });
      if (url === "/api/hello") {
        return new Response(
          JSON.stringify({ message: "ok", ping_id: "11111111-1111-1111-1111-111111111111" }),
          { status: 200 },
        );
      }
      if (url === "/api/student/homeworks") {
        return new Response(JSON.stringify({ homeworks: [] }), { status: 200 });
      }
      if (url.startsWith("/api/conversations")) {
        return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }),
  );
});

afterEach(cleanup);

describe("chat surfaces throttle streamed re-renders (#277)", () => {
  it("passes experimental_throttle to every useChat instance", async () => {
    const { default: App } = await import("./App");
    const { AuthProvider } = await import("./components/AuthProvider");
    render(
      <MemoryRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>,
    );

    // Both surfaces (section chat and tutor rail) construct a useChat.
    await waitFor(() => expect(useChatCalls.length).toBeGreaterThanOrEqual(2));

    // The regression: this was absent on both, so the SDK re-rendered App on
    // every streamed chunk.
    for (const opts of useChatCalls) {
      expect(opts.experimental_throttle).toBeTypeOf("number");
      expect(opts.experimental_throttle as number).toBeGreaterThan(0);
    }
  });
});
