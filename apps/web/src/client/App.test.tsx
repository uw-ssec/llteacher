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
    // #6: the row (which the title is part of, per #4's original contract)
    // is the select control -- a small pencil icon is the rename trigger
    // instead (see ConversationListItem's doc comment for the split).
    await user.click(await screen.findByRole("button", { name: "Select conversation: Existing tutor chat" }));

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

  // #4 fix-round 2: the hydration fix above introduced an async gap
  // (fetch /messages, then apply) that didn't exist when selection was a
  // synchronous setState. Regression test for the resulting race: select
  // conversation A, then B before A's /messages response lands, then let
  // A's response resolve LAST (after B's) -- the exact interleaving a
  // slower/earlier-started request can produce. Without the
  // latestTutorSelectionRef guard, A's late response would silently flip
  // the chat column (and the sidebar's selected-row highlight) back to A
  // even though B was the student's actual last action.
  it("discards a stale /messages response when a later selection supersedes it before the first resolves", async () => {
    vi.stubGlobal("CSS", { supports: () => true });
    Element.prototype.scrollIntoView = vi.fn();

    let resolveA!: (res: Response) => void;
    let resolveB!: (res: Response) => void;
    const pendingA = new Promise<Response>((resolve) => {
      resolveA = resolve;
    });
    const pendingB = new Promise<Response>((resolve) => {
      resolveB = resolve;
    });

    const conversationFixture = (id: string, title: string) => ({
      id,
      ownerUserId: "u1",
      courseId: "course-a",
      sectionId: null,
      kind: "tutor" as const,
      title,
      isDeleted: false,
      deletedAt: null,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      messageCount: 1,
    });

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
          return new Response(
            JSON.stringify([conversationFixture("conv-a", "Conversation A"), conversationFixture("conv-b", "Conversation B")]),
            { status: 200 },
          );
        }
        if (url === "/api/conversations/conv-a/messages") return pendingA;
        if (url === "/api/conversations/conv-b/messages") return pendingB;
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

    const user = userEvent.setup();
    // Click order: A, then B, both before either /messages response lands.
    await user.click(await screen.findByRole("button", { name: "Select conversation: Conversation A" }));
    await user.click(screen.getByRole("button", { name: "Select conversation: Conversation B" }));

    // Resolve OUT of click order: B (clicked second) resolves first, A
    // (clicked first) resolves last -- exactly the interleaving the race
    // permits (A's history could plausibly take longer to fetch/parse).
    resolveB(
      new Response(JSON.stringify([{ id: "mb", role: "user", parts: [{ type: "text", text: "message from B" }] }]), {
        status: 200,
      }),
    );
    await screen.findByText("message from B");

    resolveA(
      new Response(JSON.stringify([{ id: "ma", role: "user", parts: [{ type: "text", text: "message from A" }] }]), {
        status: 200,
      }),
    );
    // Flush A's now-resolved (but stale) promise through microtasks/effects.
    // Without the fix this is exactly where the UI would silently flip back
    // to conversation A.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.queryByText("message from A")).toBeNull();
    expect(screen.getByText("message from B")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Select conversation: Conversation B" }).getAttribute("aria-current"),
    ).toBe("true");
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
    await user.click(await screen.findByRole("button", { name: "Select conversation: Existing tutor chat" }));
    await screen.findByText("STATS 311 · TUTOR CHAT");

    await user.click(screen.getByRole("button", { name: /Sec 1/ }));
    await screen.findByText("STATS 311 · HW 3 · Section 3 P-VALUES");
    expect(screen.queryByText("STATS 311 · TUTOR CHAT")).toBeNull();
  });
});

// #6: the tutor chat column's header title -- mirrors whatever
// TutorConversationsList's onSelectedConversationChange last reported (see
// that prop's doc comment on why App.tsx doesn't fetch this itself), and
// renames route through the SAME renameConversation TutorConversationsList
// exposes via onRenameHandlerReady, so a header rename shows up in the list
// row too and vice versa -- one hook instance, one `conversations` array.
describe("App tutor conversation header rename (#6)", () => {
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
        sections: [{ id: "s1", title: "Sec 1", order: 1, status: "not_started", conversationId: null }],
      },
    ],
  };

  function stubFetch(extra: {
    onPatch?: (id: string, body: unknown) => Response;
  }) {
    vi.stubGlobal("CSS", { supports: () => true });
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/profile") return new Response(JSON.stringify({}), { status: 200 });
        if (url === "/api/hello") {
          return new Response(JSON.stringify({ message: "ok", ping_id: "1".repeat(8) }), { status: 200 });
        }
        if (url === "/api/student/homeworks") return new Response(JSON.stringify(HOMEWORK_FIXTURE), { status: 200 });
        if (url.startsWith("/api/conversations?")) {
          return new Response(
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
          );
        }
        if (url === "/api/conversations/tutor-conv-1/messages") return new Response(JSON.stringify([]), { status: 200 });
        const patchMatch = url.match(/^\/api\/conversations\/([^/]+)$/);
        if (patchMatch && init?.method === "PATCH") {
          const body = JSON.parse(String(init.body));
          return extra.onPatch
            ? extra.onPatch(patchMatch[1]!, body)
            : new Response(JSON.stringify({ error: "unexpected PATCH" }), { status: 500 });
        }
        throw new Error(`unexpected fetch to ${url}`);
      }),
    );
  }

  it("shows the selected tutor conversation's title as an editable heading in the chat column", async () => {
    stubFetch({});
    render(
      <MemoryRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>,
    );

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Select conversation: Existing tutor chat" }));
    await screen.findByText("STATS 311 · TUTOR CHAT");

    // The heading itself: dom-accessibility-api computes an ancestor's
    // "name from content" from descendants' visible text, not a nested
    // element's own aria-label -- so the h1's accessible name is the plain
    // title text, not the button's "Rename conversation: ..." label.
    expect(await screen.findByRole("heading", { name: "Existing tutor chat" })).toBeTruthy();
    // The header's own rename trigger -- queried directly (its aria-label
    // is its own accessible name, just not one that propagates up to the
    // ancestor heading above) -- a second, distinct occurrence of this
    // "Rename conversation: ..." pattern from the list row's own trigger,
    // which is scoped to a DIFFERENT className ("Rename: ...", no
    // "conversation" -- see ConversationView's renameLabel prop) so the two
    // never collide.
    expect(
      await screen.findByRole("button", { name: "Rename conversation: Existing tutor chat" }),
    ).toBeTruthy();
  });

  it("renaming from the header PATCHes the conversation and updates both the header and the list row", async () => {
    const patchCalls: Array<{ id: string; body: unknown }> = [];
    stubFetch({
      onPatch: (id, body) => {
        patchCalls.push({ id, body });
        return new Response(
          JSON.stringify({
            id: "tutor-conv-1",
            ownerUserId: "u1",
            courseId: "course-a",
            sectionId: null,
            kind: "tutor",
            title: "Renamed from header",
            isDeleted: false,
            deletedAt: null,
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:05:00.000Z",
          }),
          { status: 200 },
        );
      },
    });
    render(
      <MemoryRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>,
    );

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Select conversation: Existing tutor chat" }));
    await screen.findByRole("button", { name: "Rename conversation: Existing tutor chat" });

    await user.click(screen.getByRole("button", { name: "Rename conversation: Existing tutor chat" }));
    const input = screen.getByLabelText("Edit title");
    await user.clear(input);
    await user.type(input, "Renamed from header{Enter}");

    expect(patchCalls).toEqual([{ id: "tutor-conv-1", body: { title: "Renamed from header" } }]);
    // The header reflects the new title.
    await screen.findByRole("heading", { name: "Renamed from header" });
    // ...and so does the list row -- same underlying hook state, not a
    // second copy that could drift.
    expect(await screen.findByRole("button", { name: "Select conversation: Renamed from header" })).toBeTruthy();
  });

  it("does not show a header title for the homework-section chat (no per-conversation title there)", async () => {
    stubFetch({});
    render(
      <MemoryRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>,
    );

    await screen.findByText("STATS 311 · HW 3 · Section 3 P-VALUES");
    expect(screen.queryByRole("button", { name: /Rename conversation/ })).toBeNull();
  });
});

// #144: chat crashes on malformed model output; failures are silent.
// Covers the two useChat-status-driven requirements for the SECTION chat
// (the homework/syllabus chat, App's first useChat instance): guarding
// send-while-streaming, and surfacing a failed turn instead of it silently
// vanishing. The tutor chat's equivalents (App's SECOND, independently
// wired useChat instance) are covered separately below -- the issue's own
// context flags that both instances need the fix, not just whichever is
// nearer the top of the file.
describe("App section chat streaming guard + error surfacing (#144)", () => {
  function stubHomeworkFetch(chatFetch: typeof fetch) {
    vi.stubGlobal("CSS", { supports: () => true });
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/profile") return new Response(JSON.stringify({}), { status: 200 });
        if (url === "/api/hello") {
          return new Response(JSON.stringify({ message: "ok", ping_id: "1".repeat(8) }), { status: 200 });
        }
        if (url === "/api/student/homeworks") return new Response(JSON.stringify({ homeworks: [] }), { status: 200 });
        if (url.startsWith("/api/conversations?")) return new Response(JSON.stringify([]), { status: 200 });
        if (url === "/api/chat") return chatFetch(input, init);
        throw new Error(`unexpected fetch to ${url}`);
      }),
    );
  }

  it("disables the composer while a turn is in flight and does not fire a second /api/chat request for a same-message Enter", async () => {
    let chatCallCount = 0;
    let resolveChat!: (res: Response) => void;
    const pendingChat = new Promise<Response>((resolve) => {
      resolveChat = resolve;
    });
    stubHomeworkFetch(async () => {
      chatCallCount += 1;
      return pendingChat;
    });

    render(
      <MemoryRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>,
    );

    const composer = (await screen.findByLabelText("Message input")) as HTMLTextAreaElement;
    const user = userEvent.setup();
    await user.type(composer, "first message{Enter}");

    // Status flips to "submitted" synchronously inside sendMessage, before
    // the (still-pending) fetch resolves -- the composer must reflect that
    // immediately, not just once a response eventually arrives.
    await waitFor(() => expect(composer.disabled).toBe(true));
    expect(chatCallCount).toBe(1);

    // Disabled textareas reject keystrokes/Enter entirely in jsdom -- this
    // proves the guard is load-bearing (AI SDK v5's Chat#sendMessage has no
    // internal guard of its own against being called while already in
    // flight), not merely a visual flag nobody enforces.
    await user.type(composer, "second message{Enter}");
    expect(chatCallCount).toBe(1);
    // The composer's draft was already cleared on the first submit (see
    // ConversationView's handleSubmit) -- disabled textareas reject further
    // keystrokes entirely, so it stays empty rather than accumulating
    // "second message".
    expect(composer.value).toBe("");

    // Let the first turn resolve, and confirm the composer comes back.
    resolveChat(
      new Response(
        [
          `data: ${JSON.stringify({ type: "start" })}\n\n`,
          `data: ${JSON.stringify({ type: "start-step" })}\n\n`,
          `data: ${JSON.stringify({ type: "text-start", id: "t1" })}\n\n`,
          `data: ${JSON.stringify({ type: "text-delta", id: "t1", delta: "reply" })}\n\n`,
          `data: ${JSON.stringify({ type: "text-end", id: "t1" })}\n\n`,
          `data: ${JSON.stringify({ type: "finish-step" })}\n\n`,
          `data: ${JSON.stringify({ type: "finish" })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""),
        { status: 200, headers: { "content-type": "text/event-stream", "x-conversation-id": "conv-1" } },
      ),
    );
    await screen.findByText("reply");
    await waitFor(() => expect(composer.disabled).toBe(false));
  });

  it("surfaces a failed turn as an inline retryable error instead of silently disappearing, and regenerate() recovers it", async () => {
    let chatCallCount = 0;
    stubHomeworkFetch(async () => {
      chatCallCount += 1;
      if (chatCallCount === 1) {
        // HttpChatTransport throws `new Error(await response.text())` for a
        // non-ok response -- this is the exact path a failed/rate-limited
        // /api/chat request takes in production.
        return new Response("rate limited", { status: 429 });
      }
      return new Response(
        [
          `data: ${JSON.stringify({ type: "start" })}\n\n`,
          `data: ${JSON.stringify({ type: "start-step" })}\n\n`,
          `data: ${JSON.stringify({ type: "text-start", id: "t1" })}\n\n`,
          `data: ${JSON.stringify({ type: "text-delta", id: "t1", delta: "recovered reply" })}\n\n`,
          `data: ${JSON.stringify({ type: "text-end", id: "t1" })}\n\n`,
          `data: ${JSON.stringify({ type: "finish-step" })}\n\n`,
          `data: ${JSON.stringify({ type: "finish" })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""),
        { status: 200, headers: { "content-type": "text/event-stream", "x-conversation-id": "conv-1" } },
      );
    });

    render(
      <MemoryRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>,
    );

    const composer = (await screen.findByLabelText("Message input")) as HTMLTextAreaElement;
    const user = userEvent.setup();
    await user.type(composer, "will fail{Enter}");

    // The synthetic "thinking" placeholder (chatStatus === "submitted") must
    // resolve into a visible, retryable error row -- not just vanish, which
    // was #144's actual complaint.
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(await screen.findByText("rate limited")).toBeTruthy();
    expect(composer.disabled).toBe(true); // status "error" is not "ready" either

    await user.click(screen.getByRole("button", { name: "Retry" }));

    await screen.findByText("recovered reply");
    expect(chatCallCount).toBe(2);
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByLabelText("Message input") as HTMLTextAreaElement).disabled).toBe(false);
  });
});

// #144: same two requirements as directly above, but for App's SECOND,
// independently-wired useChat instance (the tutor chat) -- confirms the fix
// isn't scoped to only whichever useChat call happens to sit nearer the top
// of App.tsx.
describe("App tutor chat streaming guard + error surfacing (#144)", () => {
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
        sections: [{ id: "s1", title: "Sec 1", order: 1, status: "not_started", conversationId: null }],
      },
    ],
  };

  function stubTutorFetch(chatFetch: typeof fetch) {
    vi.stubGlobal("CSS", { supports: () => true });
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/profile") return new Response(JSON.stringify({}), { status: 200 });
        if (url === "/api/hello") {
          return new Response(JSON.stringify({ message: "ok", ping_id: "1".repeat(8) }), { status: 200 });
        }
        if (url === "/api/student/homeworks") return new Response(JSON.stringify(HOMEWORK_FIXTURE), { status: 200 });
        if (url.startsWith("/api/conversations?")) return new Response(JSON.stringify([]), { status: 200 });
        if (url === "/api/conversations" && init?.method === "POST") {
          return new Response(
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
          );
        }
        if (url === "/api/chat") return chatFetch(input, init);
        throw new Error(`unexpected fetch to ${url}`);
      }),
    );
  }

  it("surfaces a failed tutor turn as an inline retryable error, and disables the tutor composer while errored", async () => {
    let chatCallCount = 0;
    stubTutorFetch(async () => {
      chatCallCount += 1;
      if (chatCallCount === 1) return new Response("tutor stream failed", { status: 500 });
      return new Response(
        [
          `data: ${JSON.stringify({ type: "start" })}\n\n`,
          `data: ${JSON.stringify({ type: "start-step" })}\n\n`,
          `data: ${JSON.stringify({ type: "text-start", id: "t1" })}\n\n`,
          `data: ${JSON.stringify({ type: "text-delta", id: "t1", delta: "tutor recovered" })}\n\n`,
          `data: ${JSON.stringify({ type: "text-end", id: "t1" })}\n\n`,
          `data: ${JSON.stringify({ type: "finish-step" })}\n\n`,
          `data: ${JSON.stringify({ type: "finish" })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""),
        { status: 200, headers: { "content-type": "text/event-stream", "x-conversation-id": "tutor-conv-1" } },
      );
    });

    render(
      <MemoryRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>,
    );

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "New conversation" }));
    await screen.findByText("STATS 311 · TUTOR CHAT");

    const composer = (await screen.findByLabelText("Message input")) as HTMLTextAreaElement;
    await user.type(composer, "tutor question{Enter}");

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(await screen.findByText("tutor stream failed")).toBeTruthy();
    expect(composer.disabled).toBe(true);

    await user.click(screen.getByRole("button", { name: "Retry" }));

    await screen.findByText("tutor recovered");
    expect(chatCallCount).toBe(2);
    expect(screen.queryByRole("alert")).toBeNull();
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
