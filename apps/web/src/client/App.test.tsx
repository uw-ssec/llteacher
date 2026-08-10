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

/* #4: the tutor-conversations rail. Renders the real App (not a mocked
   TutorConversationsList) against a fake backend, exercising the same
   integration points the #3 follow-up test above does -- these cover the
   issue's own Testing Strategy items 3-4 ("New conversation button creates
   and navigates" / "Conversation selection updates ... state used to show
   the chat") at the App level, where TutorConversationsList's own tests
   only go as far as "reports the id up" without checking that App actually
   switches the chat column on it. */
describe("App tutor-conversations rail (#4)", () => {
  const HOMEWORK_FIXTURE = {
    homeworks: [
      {
        id: "hw-1",
        courseId: "course-a",
        title: "HW 3",
        description: "d",
        dueDate: "2099-01-01T00:00:00.000Z",
        completedPercentage: 0,
        inProgressPercentage: 0,
        sections: [
          { id: "s1", title: "Sec 1", order: 1, status: "not_started", conversationId: null },
        ],
      },
    ],
  };

  function stubBaseFetch(extra: {
    onConversationsGet?: () => Response;
    onConversationsPost?: (body: unknown) => Response;
    onConversationMessagesGet?: (conversationId: string) => Response;
  }) {
    vi.stubGlobal("CSS", { supports: () => true });
    Element.prototype.scrollIntoView = vi.fn();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/profile") return new Response(JSON.stringify({}), { status: 200 });
        if (url === "/api/hello") {
          return new Response(
            JSON.stringify({ message: "ok", ping_id: "11111111-1111-1111-1111-111111111111" }),
            { status: 200 },
          );
        }
        if (url === "/api/student/homeworks") {
          return new Response(JSON.stringify(HOMEWORK_FIXTURE), { status: 200 });
        }
        if (url.startsWith("/api/conversations?")) {
          return extra.onConversationsGet
            ? extra.onConversationsGet()
            : new Response(JSON.stringify([]), { status: 200 });
        }
        if (url === "/api/conversations" && init?.method === "POST") {
          return extra.onConversationsPost
            ? extra.onConversationsPost(JSON.parse(String(init.body)))
            : new Response(JSON.stringify({ error: "unexpected POST" }), { status: 500 });
        }
        // #4 fix-round: history hydration -- defaults to an empty history so
        // existing tests that don't care about hydration itself (e.g.
        // "selecting a homework section switches back") don't need to know
        // about this endpoint's existence.
        const messagesMatch = url.match(/^\/api\/conversations\/([^/]+)\/messages$/);
        if (messagesMatch) {
          return extra.onConversationMessagesGet
            ? extra.onConversationMessagesGet(messagesMatch[1]!)
            : new Response(JSON.stringify([]), { status: 200 });
        }
        throw new Error(`unexpected fetch to ${url}`);
      }),
    );
  }

  it("renders the tutor rail scoped to the homework's courseId, alongside the homework sidebar", async () => {
    const conversationsGetUrls: string[] = [];
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
        if (url === "/api/student/homeworks") return new Response(JSON.stringify(HOMEWORK_FIXTURE), { status: 200 });
        if (url.startsWith("/api/conversations?")) {
          conversationsGetUrls.push(url);
          return new Response(JSON.stringify([]), { status: 200 });
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

    expect(await screen.findByText("Tutor Chats")).toBeTruthy();
    expect(await screen.findByText("No conversations yet")).toBeTruthy();
    // Data leakage guard (Testing Strategy #1): the fetch must be scoped to
    // this student's actual courseId ("course-a" from HOMEWORK_FIXTURE),
    // never a hardcoded or missing one.
    await waitFor(() =>
      expect(conversationsGetUrls).toContain("/api/conversations?courseId=course-a&kind=tutor"),
    );
    // The homework sidebar (a different surface, see TutorConversationsList's
    // doc comment) still renders alongside it.
    expect(screen.getByRole("button", { name: /Sec 1/ })).toBeTruthy();
  });

  it("creating a tutor conversation switches the chat column to it, and sends chat turns with its conversationId", async () => {
    const chatCalls: Array<{ conversationId?: string }> = [];
    stubBaseFetch({
      onConversationsPost: () =>
        new Response(
          JSON.stringify({
            id: "tutor-conv-1",
            ownerUserId: "u1",
            courseId: "course-a",
            sectionId: null,
            kind: "tutor",
            title: "New Conversation",
            isDeleted: false,
            deletedAt: null,
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
          }),
          { status: 201 },
        ),
    });
    // Layer the /api/chat handler on top of the shared base stub.
    const baseFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/chat") {
          const body = JSON.parse(String(init?.body)) as { conversationId?: string };
          chatCalls.push(body);
          const chunks = [
            { type: "start" },
            { type: "start-step" },
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "tutor reply" },
            { type: "text-end", id: "t1" },
            { type: "finish-step" },
            { type: "finish" },
          ];
          const streamBody = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
          return new Response(streamBody, {
            status: 200,
            headers: { "content-type": "text/event-stream", "x-conversation-id": body.conversationId ?? "unexpected" },
          });
        }
        return baseFetch(input, init);
      }),
    );

    render(
      <MemoryRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>,
    );

    await screen.findByText("No conversations yet");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "New conversation" }));

    // The chat column switched to the tutor surface (breadcrumb changed).
    await screen.findByText("STATS 311 · TUTOR CHAT");

    const composer = await screen.findByLabelText("Message input");
    await user.type(composer, "hello tutor{Enter}");
    await screen.findByText("tutor reply");

    expect(chatCalls).toHaveLength(1);
    expect(chatCalls[0]!.conversationId).toBe("tutor-conv-1");
  });

  // #4 fix-round: the core regression test for the code-review finding.
  // Selecting an existing tutor conversation must not just *display* its
  // prior messages -- chat.ts's chatHandler builds the model's context via
  // convertToModelMessages(uiMessages) over exactly what the client sends,
  // so the next /api/chat request must actually include the hydrated
  // history, or the LLM silently forgets the whole prior exchange. This
  // test fails on the pre-fix code (which hydrated nothing, so `/api/chat`
  // would receive only the freshly-typed message).
  it("selecting an existing tutor conversation hydrates its history into the chat column AND into the next /api/chat request", async () => {
    const chatCalls: Array<{ conversationId?: string; messages: Array<{ role: string }> }> = [];
    stubBaseFetch({
      onConversationsGet: () =>
        new Response(
          JSON.stringify([
            {
              id: "tutor-conv-1",
              ownerUserId: "u1",
              courseId: "course-a",
              sectionId: null,
              kind: "tutor",
              title: "Existing tutor chat",
              isDeleted: false,
              deletedAt: null,
              createdAt: "2026-08-01T00:00:00.000Z",
              updatedAt: "2026-08-01T00:00:00.000Z",
              messageCount: 2,
            },
          ]),
          { status: 200 },
        ),
      onConversationMessagesGet: (conversationId) => {
        expect(conversationId).toBe("tutor-conv-1");
        return new Response(
          JSON.stringify([
            { id: "m1", role: "user", parts: [{ type: "text", text: "prior question" }] },
            { id: "m2", role: "assistant", parts: [{ type: "text", text: "prior answer" }] },
          ]),
          { status: 200 },
        );
      },
    });
    const baseFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/chat") {
          const body = JSON.parse(String(init?.body)) as {
            conversationId?: string;
            messages: Array<{ role: string }>;
          };
          chatCalls.push(body);
          return chatStreamResponse(body.conversationId ?? "unexpected", "follow-up reply");
        }
        return baseFetch(input, init);
      }),
    );

    render(
      <MemoryRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>,
    );

    const user = userEvent.setup();
    await user.click(await screen.findByText("Existing tutor chat"));

    // The chat column shows the persisted history, not an empty thread.
    expect(await screen.findByText("prior question")).toBeTruthy();
    expect(await screen.findByText("prior answer")).toBeTruthy();

    const composer = await screen.findByLabelText("Message input");
    await user.type(composer, "follow-up question{Enter}");
    await screen.findByText("follow-up reply");

    expect(chatCalls).toHaveLength(1);
    expect(chatCalls[0]!.conversationId).toBe("tutor-conv-1");
    // The actual bug: the outgoing model-context array must include the
    // hydrated prior turns, not just the message just typed.
    expect(chatCalls[0]!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("selecting a homework section switches the chat column back out of the tutor surface", async () => {
    stubBaseFetch({
      onConversationsGet: () =>
        new Response(
          JSON.stringify([
            {
              id: "tutor-conv-1",
              ownerUserId: "u1",
              courseId: "course-a",
              sectionId: null,
              kind: "tutor",
              title: "Existing tutor chat",
              isDeleted: false,
              deletedAt: null,
              createdAt: "2026-08-01T00:00:00.000Z",
              updatedAt: "2026-08-01T00:00:00.000Z",
              messageCount: 2,
            },
          ]),
          { status: 200 },
        ),
    });

    render(
      <MemoryRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>,
    );

    const user = userEvent.setup();
    await user.click(await screen.findByText("Existing tutor chat"));
    await screen.findByText("STATS 311 · TUTOR CHAT");

    await user.click(screen.getByRole("button", { name: /Sec 1/ }));
    await screen.findByText("STATS 311 · HW 3 · Section 3 P-VALUES");
    expect(screen.queryByText("STATS 311 · TUTOR CHAT")).toBeNull();
  });
});

// Testing Strategy #5 ("Sidebar collapse state persists"): the tutor rail's
// own localStorage key (TUTOR_SIDEBAR_COLLAPSED_KEY) must be independent of
// the homework sidebar's -- toggling one must not move the other, and the
// preference must survive a remount (the localStorage-backed lazy
// initializer, same mechanism the homework sidebar already had covered
// only implicitly before #4).
describe("App tutor sidebar collapse persistence (#4)", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("persists the tutor rail's collapsed state across a remount, independently of the homework sidebar's", async () => {
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

    const { unmount } = render(
      <MemoryRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>,
    );

    const toggle = await screen.findByRole("button", { name: "Collapse tutor conversations" });
    const user = userEvent.setup();
    await user.click(toggle);

    await waitFor(() =>
      expect(window.localStorage.getItem("llteacher:tutor-sidebar-collapsed")).toBe("true"),
    );
    // The homework sidebar's own key is untouched by toggling the tutor rail.
    expect(window.localStorage.getItem("llteacher:sidebar-collapsed")).not.toBe("true");

    unmount();

    render(
      <MemoryRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("button", { name: "Expand tutor conversations" })).toBeTruthy();
  });
});
