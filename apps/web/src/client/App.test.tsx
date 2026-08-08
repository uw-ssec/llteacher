// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import App, { useStudentHomework } from "./App";
import { AuthProvider } from "./components/AuthProvider";

afterEach(cleanup);

// #160: useStudentHomework parsed the response body without checking
// res.ok, so an auth/server error rendered as an empty sidebar with no
// error surfaced -- these cover the two cases that must now be
// distinguishable: a non-ok response vs. a valid-but-empty homework list.
describe("useStudentHomework", () => {
  it("sets loadError on a non-ok response, instead of throwing inside the .then chain", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })),
    );
    const { result } = renderHook(() => useStudentHomework());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.loadError).toBe(true);
    expect(result.current.sections).toEqual([]);
  });

  it("does not set loadError for a valid response with zero homeworks (genuine empty state)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ homeworks: [] }), { status: 200 })),
    );
    const { result } = renderHook(() => useStudentHomework());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.loadError).toBe(false);
    expect(result.current.sections).toEqual([]);
  });

  it("does not set loadError and populates sections for a valid non-empty response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            homeworks: [
              {
                id: "hw-1", title: "HW 1", description: "d", dueDate: "2099-01-01T00:00:00.000Z",
                completedPercentage: 0, inProgressPercentage: 0,
                sections: [{ id: "s1", title: "Sec 1", order: 1, status: "not_started", conversationId: null }],
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    const { result } = renderHook(() => useStudentHomework());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.loadError).toBe(false);
    expect(result.current.hwTitle).toBe("HW 1");
    expect(result.current.sections).toHaveLength(1);
  });
});

/* Builds a minimal, schema-valid AI SDK v5 UI message stream response body
   ("start" -> a single text part -> "finish", then the SSE "[DONE]"
   sentinel) -- the exact shape @ai-sdk/react's DefaultChatTransport parses
   back into UIMessage chunks (verified against uiMessageChunkSchema in
   node_modules/ai/dist/index.mjs, not guessed). x-conversation-id is set on
   the Response the same way chatHandler sets it in production. */
function chatStreamResponse(conversationId: string, replyText: string) {
  const chunks = [
    { type: "start" },
    { type: "start-step" },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: replyText },
    { type: "text-end", id: "t1" },
    { type: "finish-step" },
    { type: "finish" },
  ];
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream", "x-conversation-id": conversationId },
  });
}

// #3 follow-up fix: conversationId must flow into every /api/chat request
// after the first, not just be captured and then dropped. This renders the
// real App (real useChat + DefaultChatTransport, not a mocked hook) against
// a fake /api/chat that returns a real UI-message SSE stream, so it
// exercises the actual bug: the old code stashed conversationId in
// DefaultChatTransport's own `body` option, which useChat's Chat instance
// only ever reads once at mount (see the comment above useChat's call site
// in App.tsx) -- so every post-first-turn request silently kept sending no
// conversationId at all, and the server minted a brand-new conversation on
// every single turn.
describe("App chat conversationId propagation (#3 follow-up)", () => {
  it("sends the conversationId from turn 1's response on turn 2's request, not just turn 1's", async () => {
    // jsdom doesn't implement these two DOM APIs that @llteacher/ui's
    // Composer/ConversationView call unconditionally (field-sizing feature
    // detection, scroll-to-latest-message) -- stubbed so mounting the real
    // component tree doesn't throw on unrelated missing browser APIs.
    vi.stubGlobal("CSS", { supports: () => true });
    Element.prototype.scrollIntoView = vi.fn();

    const chatCalls: Array<{ conversationId?: string; messages: unknown[] }> = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/profile") {
          return new Response(JSON.stringify({}), { status: 200 });
        }
        if (url === "/api/hello") {
          return new Response(
            JSON.stringify({ message: "ok", ping_id: "11111111-1111-1111-1111-111111111111" }),
            { status: 200 },
          );
        }
        if (url === "/api/student/homeworks") {
          return new Response(JSON.stringify({ homeworks: [] }), { status: 200 });
        }
        if (url === "/api/chat") {
          const parsedBody = JSON.parse(String(init?.body)) as { conversationId?: string; messages: unknown[] };
          chatCalls.push(parsedBody);
          return chatStreamResponse("conv-1", `reply-${chatCalls.length}`);
        }
        throw new Error(`unexpected fetch to ${url}`);
      }),
    );

    render(
      <MemoryRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>,
    );

    const composer = await screen.findByLabelText("Message input");
    const user = userEvent.setup();

    await user.type(composer, "first message{Enter}");
    await screen.findByText("reply-1"); // turn 1's assistant response fully streamed in

    expect(chatCalls).toHaveLength(1);
    expect(chatCalls[0]!.conversationId).toBeUndefined(); // no conversation yet on turn 1

    await user.type(composer, "second message{Enter}");
    await screen.findByText("reply-2"); // turn 2's assistant response fully streamed in

    expect(chatCalls).toHaveLength(2);
    // The actual bug this test guards against: turn 2 must carry the
    // conversationId the server returned after turn 1, not omit it (which
    // would make the server mint a second, unrelated conversation).
    expect(chatCalls[1]!.conversationId).toBe("conv-1");
  });
});
