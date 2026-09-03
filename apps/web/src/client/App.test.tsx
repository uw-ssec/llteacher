// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, render, screen, waitFor, cleanup, within } from "@testing-library/react";
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

// #270: Composer's textarea uses aria-disabled + readOnly, not native
// `disabled` -- see Composer.tsx's own comment for why (native disabled
// blurs a focused element with nothing to restore it).
function isComposerDisabled(el: HTMLTextAreaElement): boolean {
  return el.getAttribute("aria-disabled") === "true" && el.readOnly;
}

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

/* #96/#268: a fault-injecting response for the RESPONSE half of a turn --
   the server accepted the send (2xx, so chatHandler has already persisted the
   student's message) and streamed real content, and THEN the model died
   mid-generation. ai@5.0.195 delivers that as an in-stream `error` chunk, not
   a rejected request, carrying whatever chat.ts's
   toUIMessageStreamResponse.onError returned -- the same `{error, code}`
   envelope readErrorMessage (packages/ui) classifies by `code`.

   Note what is deliberately absent: no `finish` chunk and no `text-end`. That
   is the wire shape #268's server-side fix keys off (finishReason "error", a
   text part still `state:"streaming"`), so the truncated reply is never
   persisted and a reload shows the question with no answer. */
function interruptedChatStreamResponse(conversationId: string, partialText: string) {
  const chunks = [
    { type: "start" },
    { type: "start-step" },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: partialText },
    {
      type: "error",
      errorText: JSON.stringify({
        error: "The tutor stopped partway through. Nothing you wrote was lost.",
        code: "tutor_stopped",
      }),
    },
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

// #302 review fix (Important #1b): a zero-section homework leaves
// `sectionChatKey` permanently `undefined` -- the exact state a first #302
// draft broke. @ai-sdk/react's own `shouldRecreateChat` fires on `"id" in
// options` being true even when the VALUE is `undefined` (and a missing id
// defaults to a freshly-generated one internally), so always including
// `id: sectionChatKey` in useChat's options -- rather than omitting the key
// entirely while it's `undefined` -- recreated the Chat instance on EVERY
// single render for as long as the key stayed undefined: not a one-time
// reset, a permanent per-render one. Typing (each keystroke its own render)
// and sending twice exercises many renders while the key never becomes
// defined at all.
describe("App section chat surface is not recreated every render while it has no key yet (#302 review fix)", () => {
  it("does not lose earlier turns to a per-render Chat-instance reset when the homework has zero sections", async () => {
    let chatCallCount = 0;
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
        if (url === "/api/chat") {
          chatCallCount += 1;
          return chatStreamResponse("conv-1", `reply-${chatCallCount}`);
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

    const composer = (await screen.findByLabelText("Message input")) as HTMLTextAreaElement;
    const user = userEvent.setup();
    // Typed character-by-character -- each keystroke is its own render,
    // all while sectionChatKey stays undefined the entire time.
    await user.type(composer, "first message with several keystrokes{Enter}");
    await screen.findByText("reply-1");

    await user.type(composer, "second message{Enter}");
    await screen.findByText("reply-2");

    // Both turns must still be on screen simultaneously -- a per-render
    // Chat-instance reset would have wiped turn 1's content the moment ANY
    // later render occurred (e.g. while typing turn 2's text).
    expect(screen.getByText("first message with several keystrokes")).toBeTruthy();
    expect(screen.getByText("reply-1")).toBeTruthy();
    expect(screen.getByText("second message")).toBeTruthy();
    expect(screen.getByText("reply-2")).toBeTruthy();
    expect(chatCallCount).toBe(2);
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
        courseName: "STATS 311",
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
    onConversationPatch?: (id: string, body: unknown) => Response;
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
            : new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
        }
        if (url === "/api/conversations" && init?.method === "POST") {
          return extra.onConversationsPost
            ? extra.onConversationsPost(JSON.parse(String(init.body)))
            : new Response(JSON.stringify({ error: "unexpected POST" }), { status: 500 });
        }
        // #4: history hydration -- defaults to an empty history so tests
        // that don't care about hydration itself (e.g. "selecting a homework
        // section switches back") don't need to know about this endpoint's
        // existence.
        // #280: matches with or without a query string -- fetchConversationHistory
        // now requests an explicit `?limit=` param.
        const messagesMatch = url.match(/^\/api\/conversations\/([^/]+)\/messages(?:\?.*)?$/);
        if (messagesMatch) {
          return extra.onConversationMessagesGet
            ? extra.onConversationMessagesGet(messagesMatch[1]!)
            : new Response(JSON.stringify([]), { status: 200 });
        }
        // #287: auto-title-on-first-message PATCHes here via the same
        // renameConversation the header/rail rename UI uses.
        const patchMatch = url.match(/^\/api\/conversations\/([^/]+)$/);
        if (patchMatch && init?.method === "PATCH") {
          const body = JSON.parse(String(init.body));
          return extra.onConversationPatch
            ? extra.onConversationPatch(patchMatch[1]!, body)
            : new Response(JSON.stringify({ error: "unexpected PATCH" }), { status: 500 });
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
          return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
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
    expect(await screen.findByText(/Start one to ask about anything outside a section\./)).toBeTruthy();
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

  it("creating a tutor conversation switches the chat column to it, and sends chat turns with its conversationId and courseId (#304)", async () => {
    const chatCalls: Array<{ conversationId?: string; courseId?: string }> = [];
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
          const body = JSON.parse(String(init?.body)) as { conversationId?: string; courseId?: string };
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

    await screen.findByText(/Start one to ask about anything outside a section\./);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "New conversation" }));

    // The chat column switched to the tutor surface (breadcrumb changed).
    await screen.findByText("TUTOR CHAT");

    const composer = await screen.findByLabelText("Message input");
    await user.type(composer, "hello tutor{Enter}");
    await screen.findByText("tutor reply");

    expect(chatCalls).toHaveLength(1);
    expect(chatCalls[0]!.conversationId).toBe("tutor-conv-1");
    // #304: the tutor rail sends the courseId it already holds on every
    // turn, not only the section path -- previously omitted entirely, so
    // chatHandler's conversationId branch had no courseId to fall back to
    // if it ever needed one.
    expect(chatCalls[0]!.courseId).toBe("course-a");
  });

  // #287: #231's auto-titling never ran on any path a student could
  // actually reach -- every conversation created via "New conversation"
  // stayed titled "New Conversation" forever. The fix moved onto THIS path:
  // App.tsx's handleSendTutorMessage now PATCHes a derived title, reusing
  // renameConversation, right after sending a brand-new conversation's
  // first message.
  it("sending the first message in a brand-new tutor conversation auto-titles it from that message (#287)", async () => {
    const patchCalls: Array<{ id: string; body: unknown }> = [];
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
      onConversationPatch: (id, body) => {
        patchCalls.push({ id, body });
        const title = (body as { title: string }).title;
        return new Response(
          JSON.stringify({
            id: "tutor-conv-1",
            ownerUserId: "u1",
            courseId: "course-a",
            sectionId: null,
            kind: "tutor",
            title,
            isDeleted: false,
            deletedAt: null,
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:05:00.000Z",
          }),
          { status: 200 },
        );
      },
    });
    // Layer the /api/chat handler on top of the shared base stub, same as
    // the test above.
    const baseFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/chat") {
          const body = JSON.parse(String(init?.body)) as { conversationId?: string };
          return chatStreamResponse(body.conversationId ?? "unexpected", "tutor reply");
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

    await screen.findByText(/Start one to ask about anything outside a section\./);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "New conversation" }));
    await screen.findByText("TUTOR CHAT");

    const composer = await screen.findByLabelText("Message input");
    await user.type(composer, "help me understand p-values{Enter}");
    await screen.findByText("tutor reply");

    expect(patchCalls).toEqual([
      { id: "tutor-conv-1", body: { title: "help me understand p-values" } },
    ]);
    // The rail row (and the header, once selected) reflects the derived
    // title instead of the default -- proof this landed somewhere a
    // student can actually see it, not just that the network call fired.
    expect(
      await screen.findByRole("button", { name: "Select conversation: help me understand p-values" }),
    ).toBeTruthy();
  });

  // #287: manually renaming a brand-new conversation BEFORE its first
  // message must win -- the auto-title must never clobber a title the
  // student picked themselves. Covers the "never overwrite a
  // manually-set title" constraint directly, not just via the
  // title-still-default gate's absence of a positive counter-test.
  it("does not auto-title a conversation whose title was already changed before the first message (#287)", async () => {
    const patchCalls: Array<{ id: string; body: unknown }> = [];
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
      onConversationPatch: (id, body) => {
        patchCalls.push({ id, body });
        const title = (body as { title: string }).title;
        return new Response(
          JSON.stringify({
            id: "tutor-conv-1",
            ownerUserId: "u1",
            courseId: "course-a",
            sectionId: null,
            kind: "tutor",
            title,
            isDeleted: false,
            deletedAt: null,
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:05:00.000Z",
          }),
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
          const body = JSON.parse(String(init?.body)) as { conversationId?: string };
          return chatStreamResponse(body.conversationId ?? "unexpected", "tutor reply");
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

    await screen.findByText(/Start one to ask about anything outside a section\./);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "New conversation" }));
    await screen.findByText("TUTOR CHAT");

    // Manually rename via the chat header BEFORE sending any message.
    await user.click(
      await screen.findByRole("button", { name: "Rename conversation: New Conversation" }),
    );
    const input = screen.getByLabelText("Edit title");
    await user.clear(input);
    await user.type(input, "My own title{Enter}");
    await screen.findByRole("heading", { name: "My own title" });
    expect(patchCalls).toEqual([{ id: "tutor-conv-1", body: { title: "My own title" } }]);

    const composer = await screen.findByLabelText("Message input");
    await user.type(composer, "help me understand p-values{Enter}");
    await screen.findByText("tutor reply");

    // No SECOND patch call from the auto-title path -- the manual rename
    // already moved the title off the default, so the send-time gate never
    // fires.
    expect(patchCalls).toEqual([{ id: "tutor-conv-1", body: { title: "My own title" } }]);
  });

  // #287 review: the gate is title-only, deliberately NOT also conditioned
  // on messageCount === 0 -- a stricter gate was tried and rejected because
  // it forecloses exactly this self-healing case. A conversation that
  // ALREADY has messages but is still (for whatever reason -- a prior
  // transient PATCH failure, or simply predating this fix) stuck at the
  // default title must still get titled on its next message, not stay
  // stuck forever because its messageCount can never again be 0.
  it("self-heals an existing multi-message conversation still stuck at the default title (#287 review)", async () => {
    const patchCalls: Array<{ id: string; body: unknown }> = [];
    stubBaseFetch({
      onConversationsGet: () =>
        new Response(
          JSON.stringify({
            items: [
              {
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
                // Already has messages -- NOT a brand-new, empty
                // conversation -- yet its title never got auto-titled.
                messageCount: 2,
              },
            ],
            nextCursor: null,
          }),
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
      onConversationPatch: (id, body) => {
        patchCalls.push({ id, body });
        const title = (body as { title: string }).title;
        return new Response(
          JSON.stringify({
            id: "tutor-conv-1",
            ownerUserId: "u1",
            courseId: "course-a",
            sectionId: null,
            kind: "tutor",
            title,
            isDeleted: false,
            deletedAt: null,
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:05:00.000Z",
          }),
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
          const body = JSON.parse(String(init?.body)) as { conversationId?: string };
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
    await user.click(await screen.findByRole("button", { name: "Select conversation: New Conversation" }));
    await screen.findByText("prior question");

    const composer = await screen.findByLabelText("Message input");
    await user.type(composer, "another question{Enter}");
    await screen.findByText("follow-up reply");

    expect(patchCalls).toEqual([{ id: "tutor-conv-1", body: { title: "another question" } }]);
    expect(await screen.findByRole("button", { name: "Select conversation: another question" })).toBeTruthy();
  });

  // #4: selecting an existing tutor conversation must not just *display*
  // its prior messages -- chat.ts's chatHandler builds the model's context
  // via convertToModelMessages(uiMessages) over exactly what the client
  // sends, so the next /api/chat request must actually carry the hydrated
  // history, or the LLM silently forgets the whole prior exchange. The
  // display assertion alone cannot catch that: a hydration that seeds the
  // transcript but not the outbound request looks correct on screen.
  it("selecting an existing tutor conversation hydrates its history into the chat column AND into the next /api/chat request", async () => {
    const chatCalls: Array<{ conversationId?: string; messages: Array<{ role: string }> }> = [];
    stubBaseFetch({
      onConversationsGet: () =>
        new Response(
          JSON.stringify({
            items: [
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
            ],
            nextCursor: null,
          }),
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
    // #317 review, blocking finding #3: the wire body is now trimmed to just
    // the message just typed -- chat.ts has never read anything but the
    // last element (server-authoritative history comes from the DB), and
    // sending the whole local array eventually 400s long conversations on
    // the byte cap. The hydrated history is still what's DISPLAYED (the
    // findByText assertions above) and still seeds useChat's own local
    // state; only what's transmitted over the wire changed.
    expect(chatCalls[0]!.messages.map((m) => m.role)).toEqual(["user"]);
  });

  // #4: because hydration is async (fetch /messages, then apply), tutor
  // selection is racy in a way a synchronous setState was not. Pins the
  // losing interleaving: select conversation A, then B before A's /messages
  // response lands, then let A's response resolve LAST (after B's) -- what
  // a slower or earlier-started request actually produces. Without the
  // latestTutorSelectionRef guard, A's late response silently flips the
  // chat column (and the sidebar's selected-row highlight) back to A even
  // though B was the student's last action.
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
            JSON.stringify({
              items: [conversationFixture("conv-a", "Conversation A"), conversationFixture("conv-b", "Conversation B")],
              nextCursor: null,
            }),
            { status: 200 },
          );
        }
        if (url.startsWith("/api/conversations/conv-a/messages")) return pendingA;
        if (url.startsWith("/api/conversations/conv-b/messages")) return pendingB;
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
          JSON.stringify({
            items: [
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
            ],
            nextCursor: null,
          }),
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
    await screen.findByText("TUTOR CHAT");

    await user.click(screen.getByRole("button", { name: /Sec 1/ }));
    await screen.findByText("Section 1: Sec 1");
    expect(screen.queryByText("TUTOR CHAT")).toBeNull();
  });

  // #292 (review fix): the mis-credit bug's own motivating scenario, driven
  // with real timing -- a turn's stream genuinely completes only AFTER the
  // student has already switched to a different conversation.
  // `@ai-sdk/react`'s `useChat` recreates its `Chat` instance whenever `id`
  // changes, and a freshly created instance reports "ready" immediately (it
  // was never submitted/streaming) -- so switching away mid-stream produces
  // an instant, spurious "ready" transition for whatever conversation is
  // selected NEXT, indistinguishable from a real completion to anything
  // watching `tutorChatStatus`. This drives that exact timing to prove the
  // fix (tying the bump to the turn's own response stream, not to
  // `useChat`'s status) doesn't fall into that trap: A's turn is left
  // genuinely unfinished when the switch happens, and only completes well
  // afterward.
  it("credits the conversation that was actually streaming, not whichever one is selected when its turn later completes", async () => {
    vi.stubGlobal("CSS", { supports: () => true });
    Element.prototype.scrollIntoView = vi.fn();

    let controllerA: ReadableStreamDefaultController<Uint8Array> | undefined;
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
            JSON.stringify({
              items: [
                { id: "conv-a", title: "Chat A", updatedAt: "2026-01-01T00:00:00.000Z", messageCount: 2 },
                { id: "conv-b", title: "Chat B", updatedAt: "2026-01-02T00:00:00.000Z", messageCount: 5 },
              ],
              nextCursor: null,
            }),
            { status: 200 },
          );
        }
        if (
          url.startsWith("/api/conversations/conv-a/messages") ||
          url.startsWith("/api/conversations/conv-b/messages")
        ) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        if (url === "/api/chat") {
          const body = JSON.parse(String(init?.body)) as { conversationId?: string };
          if (body.conversationId !== "conv-a") {
            throw new Error(`unexpected /api/chat call for conversation ${body.conversationId}`);
          }
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controllerA = controller;
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "start" })}\n\n`));
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { "content-type": "text/event-stream", "x-conversation-id": "conv-a" },
          });
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

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Select conversation: Chat A" }));
    const composer = await screen.findByLabelText("Message input");
    await user.type(composer, "question for A{Enter}");
    await waitFor(() => expect(controllerA).toBeTruthy());

    // Switch away from A WHILE its turn is still streaming server-side --
    // recreates the tutor useChat instance for B, which reports "ready"
    // on this very next render despite never having sent anything.
    await user.click(screen.getByRole("button", { name: "Select conversation: Chat B" }));
    expect(
      screen.getByRole("button", { name: "Select conversation: Chat B" }).getAttribute("aria-current"),
    ).toBe("true");

    // Flush any microtask/effect the switch itself might have queued.
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The critical assertion this test exists for: A must NOT be credited
    // yet, merely because B's fresh instance just reported "ready". A
    // version of this fix that watched `tutorChatStatus` (rather than the
    // turn's own response stream) would have credited A here, immediately
    // on the switch -- before its turn had actually finished at all.
    const rowABeforeCompletion = screen
      .getByRole("button", { name: "Select conversation: Chat A" })
      .closest(".tutor-conversation-item");
    expect(rowABeforeCompletion?.querySelector(".tutor-conversation-item__count")?.textContent).toBe(
      "2 messages",
    );

    // Only NOW does A's turn actually complete -- well after the switch,
    // and after B's fresh Chat instance has already reported "ready".
    controllerA!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "start-step" })}\n\n`));
    controllerA!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "text-start", id: "m1" })}\n\n`));
    controllerA!.enqueue(
      new TextEncoder().encode(
        `data: ${JSON.stringify({ type: "text-delta", id: "m1", delta: "answer for A" })}\n\n`,
      ),
    );
    controllerA!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "text-end", id: "m1" })}\n\n`));
    controllerA!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "finish-step" })}\n\n`));
    controllerA!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "finish" })}\n\n`));
    controllerA!.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
    controllerA!.close();

    // A's row is credited +2 (2 -> 4, the two rows a completed turn writes
    // server-side: the student's message, then the reply) even though it
    // is no longer selected; B, which received nothing, stays at 5.
    await waitFor(() => {
      const rowA = screen
        .getByRole("button", { name: "Select conversation: Chat A" })
        .closest(".tutor-conversation-item");
      expect(rowA?.querySelector(".tutor-conversation-item__count")?.textContent).toBe("4 messages");
    });
    const rowB = screen
      .getByRole("button", { name: "Select conversation: Chat B" })
      .closest(".tutor-conversation-item");
    expect(rowB?.querySelector(".tutor-conversation-item__count")?.textContent).toBe("5 messages");
  });

  // #292: the server counts message ROWS, and a completed turn writes two
  // (the student's message, then the reply) while a turn that reaches the
  // server but produces no persistable reply (chat.ts's
  // hasRenderableContent/finishReason gate) writes only the first --
  // asserted here against the REAL App-level bump path (tutorChatFetch's
  // tee'd-stream tracking), not just the isolated useTutorConversations
  // hook.
  it("credits +2 for a completed turn and +1 for a response-half failure (server row counts, not turns)", async () => {
    vi.stubGlobal("CSS", { supports: () => true });
    Element.prototype.scrollIntoView = vi.fn();
    let chatCallCount = 0;

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
            JSON.stringify({
              items: [{ id: "conv-a", title: "Chat A", updatedAt: "2026-01-01T00:00:00.000Z", messageCount: 2 }],
              nextCursor: null,
            }),
            { status: 200 },
          );
        }
        if (url.startsWith("/api/conversations/conv-a/messages")) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        if (url === "/api/chat") {
          chatCallCount += 1;
          if (chatCallCount === 1) return chatStreamResponse("conv-a", "a real reply");
          // #96/#268's shape: 2xx (the question IS persisted), then the
          // model dies mid-stream with no `finish` chunk -- exactly the
          // "response was accepted but produced nothing persistable" case.
          return interruptedChatStreamResponse("conv-a", "a partial reply");
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

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Select conversation: Chat A" }));
    const composer = await screen.findByLabelText("Message input");

    await user.type(composer, "first question{Enter}");
    await screen.findByText("a real reply");
    await waitFor(() => {
      const row = screen
        .getByRole("button", { name: "Select conversation: Chat A" })
        .closest(".tutor-conversation-item");
      expect(row?.querySelector(".tutor-conversation-item__count")?.textContent).toBe("4 messages");
    });

    await user.type(composer, "second question{Enter}");
    await screen.findByRole("alert");
    await waitFor(() => {
      const row = screen
        .getByRole("button", { name: "Select conversation: Chat A" })
        .closest(".tutor-conversation-item");
      expect(row?.querySelector(".tutor-conversation-item__count")?.textContent).toBe("5 messages");
    });
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
        courseName: "STATS 311",
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
            JSON.stringify({
              items: [
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
              ],
              nextCursor: null,
            }),
            { status: 200 },
          );
        }
        if (url.startsWith("/api/conversations/tutor-conv-1/messages")) return new Response(JSON.stringify([]), { status: 200 });
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
    await screen.findByText("TUTOR CHAT");

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

    await screen.findByText("Section 1: Sec 1");
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
        if (url.startsWith("/api/conversations?")) return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
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
    await waitFor(() => expect(isComposerDisabled(composer)).toBe(true));
    expect(chatCallCount).toBe(1);
    // #270: aria-disabled + readOnly never remove the element from the
    // focus order -- the actual regression this issue covers is that the
    // OLD native-`disabled` composer blurred itself to document.body the
    // instant this state was set, right after the student pressed Enter
    // (the composer still has focus from typing/submitting at this point).
    expect(document.activeElement).toBe(composer);

    // readOnly textareas reject keystrokes/Enter entirely in jsdom -- this
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
    await waitFor(() => expect(isComposerDisabled(composer)).toBe(false));
    // #270: focus survived the ENTIRE send/receive cycle -- never lost, so
    // nothing needed to restore it. A keyboard-only student can type their
    // next message immediately with no re-traversal of the page.
    expect(document.activeElement).toBe(composer);
  });

  it("surfaces a failed turn as an inline retryable error instead of silently disappearing, and regenerate() recovers it", async () => {
    let chatCallCount = 0;
    stubHomeworkFetch(async () => {
      chatCallCount += 1;
      if (chatCallCount === 1) {
        // #96: a RESPONSE-half failure specifically -- the send was accepted
        // (2xx), so the student's message is persisted and regenerate is the
        // correct recovery. (This test used to inject a 429, which #96
        // reclassified as a SEND-half failure: nothing persisted, no
        // regenerate offered, text handed back to the composer instead. That
        // case now has its own tests below; this one keeps #144's original
        // subject -- a failed turn must surface and Retry must recover it --
        // with the fault shape that still matches it.)
        return interruptedChatStreamResponse("conv-1", "A p-value is the probability of");
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
    expect(
      await screen.findByText("The tutor stopped partway through. Nothing you wrote was lost."),
    ).toBeTruthy();
    // #96: a response-half failure must NOT hand the text back to the
    // composer -- the server persisted that message, so re-typing it would
    // send it twice.
    expect(composer.value).toBe("");
    // "error" is not "disabled": the composer must stay USABLE in the error
    // state -- only a genuinely in-flight request
    // ("submitted"/"streaming") disables it. The section chat's
    // useChat has no `id` (unlike the tutor chat), so nothing else ever
    // resets it out of an error state; if the composer stayed disabled
    // here too, Retry (which replays the exact request that just failed)
    // would be the only way out, with no way to instead send a corrected
    // or different message.
    expect(isComposerDisabled(composer)).toBe(false);

    await user.click(screen.getByRole("button", { name: "Try again" }));

    await screen.findByText("recovered reply");
    expect(chatCallCount).toBe(2);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(isComposerDisabled(screen.getByLabelText("Message input") as HTMLTextAreaElement)).toBe(false);
  });

  it("recovers from an error by sending a fresh message directly, without using Retry", async () => {
    let chatCallCount = 0;
    stubHomeworkFetch(async () => {
      chatCallCount += 1;
      // Response-half again, so the composer starts empty for the "type a
      // genuinely different message" step below (#96 pre-fills it on a
      // send-half failure -- covered separately).
      if (chatCallCount === 1) return interruptedChatStreamResponse("conv-1", "half an answer");
      return new Response(
        [
          `data: ${JSON.stringify({ type: "start" })}\n\n`,
          `data: ${JSON.stringify({ type: "start-step" })}\n\n`,
          `data: ${JSON.stringify({ type: "text-start", id: "t1" })}\n\n`,
          `data: ${JSON.stringify({ type: "text-delta", id: "t1", delta: "fresh reply" })}\n\n`,
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
    expect(await screen.findByRole("alert")).toBeTruthy();

    // Type and send a NEW message (not clicking Retry) while chatStatus is
    // still "error" -- this must be accepted, call the model again, and
    // clear the stale error row once the new turn succeeds.
    await user.type(composer, "a different message{Enter}");
    await screen.findByText("fresh reply");

    expect(chatCallCount).toBe(2);
    expect(screen.queryByRole("alert")).toBeNull();
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
        courseName: "STATS 311",
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
        if (url.startsWith("/api/conversations?")) return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
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
      // #96: a RESPONSE-half failure (2xx, then the model died mid-stream) --
      // see the section chat's equivalent test above for why this replaced a
      // bare non-2xx here.
      if (chatCallCount === 1) return interruptedChatStreamResponse("tutor-conv-1", "Well, a p-value");
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
    await screen.findByText("TUTOR CHAT");

    const composer = (await screen.findByLabelText("Message input")) as HTMLTextAreaElement;
    await user.type(composer, "tutor question{Enter}");

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(
      await screen.findByText("The tutor stopped partway through. Nothing you wrote was lost."),
    ).toBeTruthy();
    // Same "error" != "disabled" invariant as the section chat above, which
    // has to hold independently here: the tutor chat is its own useChat
    // instance, so nothing about the section chat's behavior implies it.
    expect(isComposerDisabled(composer)).toBe(false);

    await user.click(screen.getByRole("button", { name: "Try again" }));

    await screen.findByText("tutor recovered");
    expect(chatCallCount).toBe(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

/* #96 (streaming resilience), driven through a fault-injecting mock
   transport -- the real App, the real useChat/DefaultChatTransport, and a
   stubbed `fetch` that fails in a specific, chosen place.

   The whole point of these tests is the SPLIT that #96 requirement 3 asks
   for, which the client did not make before: every failed turn used to
   render one error row with one regenerate retry, regardless of whether the
   server had ever heard of the turn.

     send half     -- the fetch threw, or the server answered non-2xx.
                      chatHandler persists the student's message BEFORE it
                      opens the stream, so nothing at all was written. The
                      un-persisted bubble must leave the transcript (a reload
                      would drop it anyway) and the words must come back in
                      the composer.
     response half -- 2xx, so the question IS persisted; only the reply died.
                      The bubble stays, the composer stays empty, and Retry
                      regenerates (covered by the #144 blocks above, which
                      now inject exactly this shape).

   Requirement 1 as amended by the controller ruling on #268 vs #96: there is
   no partial persist and no resume-from-checkpoint. An interrupted turn
   leaves the question with no answer, which is what the reload test below
   asserts against the transcript the server actually returns. */
describe("App streaming resilience: send-half vs response-half failures (#96)", () => {
  // The Critical #1 regression test below toggles the real (localStorage-
  // backed) sidebar collapse preference as its "unrelated re-render"
  // trigger -- cleared after every test in this block so it can't leak
  // into another describe (e.g. "App tutor sidebar collapse persistence
  // (#4)", which asserts exact localStorage values).
  afterEach(() => window.localStorage.clear());

  const HOMEWORK_FIXTURE = {
    homeworks: [
      {
        id: "hw-1",
        courseId: "course-a",
        courseName: "STATS 311",
        title: "HW 3",
        description: "d",
        dueDate: "2099-01-01T00:00:00.000Z",
        completedPercentage: 0,
        inProgressPercentage: 0,
        sections: [{ id: "s1", title: "Sec 1", order: 1, status: "not_started", conversationId: null }],
      },
    ],
  };

  function stubFetch(chatFetch: typeof fetch, homeworks: unknown = HOMEWORK_FIXTURE, messagesFor?: () => Response) {
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
        if (url === "/api/student/homeworks") return new Response(JSON.stringify(homeworks), { status: 200 });
        if (url.startsWith("/api/conversations?")) {
          return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
        }
        if (url.endsWith("/hints")) {
          return new Response(JSON.stringify({ used: 0, limit: null }), { status: 200 });
        }
        if (url.includes("/messages") && messagesFor) return messagesFor();
        if (url === "/api/chat") return chatFetch(input, init);
        throw new Error(`unexpected fetch to ${url}`);
      }),
    );
  }

  function renderApp() {
    render(
      <MemoryRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>,
    );
  }

  it("hands the student's words back to the composer, and drops the un-persisted bubble, when the request never reaches the server", async () => {
    let chatCallCount = 0;
    stubFetch(async () => {
      chatCallCount += 1;
      // A dropped connection: `fetch` itself rejects, so the Worker never
      // saw this request and nothing was persisted for it.
      if (chatCallCount === 1) throw new TypeError("Load failed");
      return chatStreamResponse("conv-1", "a real reply at last");
    });

    renderApp();

    const composer = (await screen.findByLabelText("Message input")) as HTMLTextAreaElement;
    const user = userEvent.setup();
    await user.type(composer, "why is my p-value 0.03?{Enter}");

    expect(await screen.findByRole("alert")).toBeTruthy();
    // The copy names the right failure: not "the tutor didn't answer" (it was
    // never asked), but "your message didn't arrive".
    expect(await screen.findByText(/didn't reach the tutor/)).toBeTruthy();

    // The requirement itself: the student's text is not lost.
    await waitFor(() => expect(composer.value).toBe("why is my p-value 0.03?"));

    // ...and it is no longer sitting in the transcript as a message the
    // server never stored. Before this, the bubble stayed on screen and then
    // silently vanished on the next reload.
    expect(screen.queryByText("why is my p-value 0.03?", { selector: "p, div, span" })).toBeNull();

    // No regenerate affordance: there is no server-side turn to regenerate.
    // The composer IS the retry.
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();

    // And that retry works: Enter on the restored text re-sends it.
    await user.type(composer, "{Enter}");
    await screen.findByText("a real reply at last");
    expect(chatCallCount).toBe(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("restores the text for a server-REFUSED send too (a non-2xx never persists anything either)", async () => {
    let chatCallCount = 0;
    stubFetch(async () => {
      chatCallCount += 1;
      if (chatCallCount === 1) {
        // #266's duplicate_message 409: the server refused this send
        // outright. Nothing persisted, and re-sending the same id can never
        // succeed -- so the text must come back for a fresh send.
        return new Response(
          JSON.stringify({ error: "A message with this clientMessageId already exists", code: "duplicate_message" }),
          { status: 409 },
        );
      }
      return chatStreamResponse("conv-1", "accepted on the second try");
    });

    renderApp();

    const composer = (await screen.findByLabelText("Message input")) as HTMLTextAreaElement;
    const user = userEvent.setup();
    await user.type(composer, "does this clash?{Enter}");

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(await screen.findByText(/it's back in the box below/)).toBeTruthy();
    await waitFor(() => expect(composer.value).toBe("does this clash?"));
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();

    await user.type(composer, "{Enter}");
    await screen.findByText("accepted on the second try");
    expect(chatCallCount).toBe(2);
  });

  it("does not clobber a draft the student is already holding when the failed send came from elsewhere", async () => {
    /* The reachable version of the "don't overwrite" guard: #80's hint
       button sends its own fixed message through the same pipeline while the
       composer may already hold the student's own half-written question. If
       that hint send is refused, restoring it would overwrite words the
       student never sent and never wants replaced. */
    stubFetch(async () => new Response("gateway timeout", { status: 504 }));

    renderApp();

    const composer = (await screen.findByLabelText("Message input")) as HTMLTextAreaElement;
    const user = userEvent.setup();
    await user.type(composer, "my own half-written question");

    await user.click(screen.getByRole("button", { name: "Give me a hint" }));
    await screen.findByRole("alert");

    // The hint's own text must not have landed on top of the student's draft.
    await waitFor(() => expect(composer.value).toBe("my own half-written question"));
    expect(composer.value).not.toContain("Give me a hint for this section");
  });

  it("clears the restored draft on a section switch, so one section's failed text can never be sent into another's conversation", async () => {
    /* #96: the section ConversationView is keyed `key={currentSection}`, so
       switching sections REMOUNTS it -- resetting both its draft and the
       `lastRestoredDraftRef` that makes a restore fire only once. A
       `sectionSendFailure` left over from section 1 therefore looks
       brand-new to section 2's fresh mount, and without the reset the
       restore effect writes section 1's failed text into section 2's empty
       composer: one Enter away from sending it into a different graded
       conversation.

       This is NOT the same as an ordinary unsent draft surviving a switch --
       the keyed remount deliberately discards a typed draft. Only the restore
       path could carry text across sections, which is why only it needs the
       explicit `[currentSection]` reset (the tutor surface's equivalent is
       keyed on `[tutorConversationId]`). */
    const twoSections = {
      homeworks: [
        {
          ...HOMEWORK_FIXTURE.homeworks[0],
          sections: [
            { id: "s1", title: "Sec 1", order: 1, status: "in_progress", conversationId: "sec-conv-1" },
            { id: "s2", title: "Sec 2", order: 2, status: "not_started", conversationId: "sec-conv-2" },
          ],
        },
      ],
    };
    stubFetch(
      // Every send fails before reaching the server.
      async () => new Response("gateway timeout", { status: 504 }),
      twoSections,
      () => new Response(JSON.stringify([]), { status: 200 }),
    );

    renderApp();

    const composer = (await screen.findByLabelText("Message input")) as HTMLTextAreaElement;
    const user = userEvent.setup();
    await user.type(composer, "section one's own question{Enter}");

    await screen.findByRole("alert");
    // Precondition: the restore genuinely happened in section 1, so a pass
    // below can't come from the restore never firing at all.
    await waitFor(() => expect(composer.value).toBe("section one's own question"));

    await user.click(screen.getByRole("button", { name: /Sec 2/ }));
    await screen.findByText(/Section 2: Sec 2/);

    // Section 2's composer is a fresh mount. It must be empty.
    const sectionTwoComposer = (await screen.findByLabelText("Message input")) as HTMLTextAreaElement;
    await waitFor(() => expect(sectionTwoComposer.value).toBe(""));
    expect(sectionTwoComposer.value).not.toContain("section one");
  });

  it("does not resurrect a restored draft the student has deliberately cleared, across an unrelated App re-render (#302 review fix, Critical #1)", async () => {
    /* ConversationView keys its "restore once" behavior on OBJECT IDENTITY
       (`restoredDraft === lastRestoredDraftRef.current`), not on the text
       value -- a first #302 draft rebuilt `{ text: ... }` as a fresh object
       literal at the App.tsx render call site every render, instead of
       reading a stable per-failure object out of hook state. That gave the
       restored draft a NEW identity on every unrelated re-render (a sidebar
       collapse, a hint-count refetch, anything), which re-fires
       ConversationView's restore effect every time -- and its only guard
       against clobbering an in-progress edit is `current.trim()`, which is
       false once the student has select-all-deleted the restored text. So a
       student who deliberately abandoned the restored draft would find it
       silently reinjected by the next re-render, one Enter from being sent
       into their graded conversation. Toggling the (unrelated) sidebar
       collapse button here stands in for "any re-render" -- it touches
       localStorage-backed state that has nothing to do with the chat
       surface at all. */
    stubFetch(async () => new Response("gateway timeout", { status: 504 }));

    renderApp();

    const composer = (await screen.findByLabelText("Message input")) as HTMLTextAreaElement;
    const user = userEvent.setup();
    await user.type(composer, "a question that will fail to send{Enter}");

    expect(await screen.findByRole("alert")).toBeTruthy();
    await waitFor(() => expect(composer.value).toBe("a question that will fail to send"));

    // The student deliberately abandons the restored draft.
    await user.clear(composer);
    expect(composer.value).toBe("");

    // An unrelated re-render -- collapsing the homework sidebar touches
    // App-level state with no relationship to the chat surface at all.
    await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));

    // The cleared draft must stay cleared.
    expect(composer.value).toBe("");
  });

  it("keeps the question on screen for a RESPONSE-half failure, and does not pre-fill the composer", async () => {
    stubFetch(async () => interruptedChatStreamResponse("conv-1", "A p-value is the probability of"));

    renderApp();

    const composer = (await screen.findByLabelText("Message input")) as HTMLTextAreaElement;
    const user = userEvent.setup();
    await user.type(composer, "explain p-values{Enter}");

    expect(await screen.findByRole("alert")).toBeTruthy();
    // The server accepted and persisted this question, so it stays in the
    // transcript -- and must NOT be handed back to the composer, or the
    // student would send it a second time.
    expect(await screen.findByText("explain p-values")).toBeTruthy();
    expect(composer.value).toBe("");
    // Regenerate IS the right recovery here: it re-sends the same
    // clientMessageId, which the server's idempotency check dedupes rather
    // than double-writing the question.
    expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("shows the question with no assistant reply on reload after an interrupted turn, and lets the student send again", async () => {
    /* Requirement 1 as amended: no partial persist, no resume endpoint. The
       transcript the server returns after an interrupted turn is exactly the
       user row (#268's onFinish gate refuses the truncated reply -- proved
       server-side in chat.errorChunk.integration.test.ts), and this is the
       client half: that transcript renders faithfully, and the plain composer
       is the "try again" affordance from it. */
    const hydrated = {
      homeworks: [
        {
          ...HOMEWORK_FIXTURE.homeworks[0],
          sections: [{ id: "s1", title: "Sec 1", order: 1, status: "in_progress", conversationId: "sec-conv-1" }],
        },
      ],
    };
    let chatCallCount = 0;
    stubFetch(
      async () => {
        chatCallCount += 1;
        return chatStreamResponse("sec-conv-1", "the answer, this time in full");
      },
      hydrated,
      () =>
        new Response(
          // Only the question. No assistant row at all -- not a partial one
          // flagged "interrupted", which is what #96's superseded original
          // design would have written here.
          JSON.stringify([{ id: "m1", role: "user", parts: [{ type: "text", text: "what does 0.03 mean?" }] }]),
          { status: 200 },
        ),
    );

    renderApp();

    expect(await screen.findByText("what does 0.03 mean?")).toBeTruthy();
    // Nothing half-written is replayed as if it were an answer.
    expect(screen.queryByText(/A p-value is the probability of/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();

    const composer = (await screen.findByLabelText("Message input")) as HTMLTextAreaElement;
    const user = userEvent.setup();
    await user.type(composer, "what does 0.03 mean?{Enter}");
    await screen.findByText("the answer, this time in full");
    expect(chatCallCount).toBe(1);
  });
});

// #302 review fix (Important #1a): the authorized behavior change this task
// made -- keying the section surface by `${sectionNumber}:${conversationId}`
// -- exists specifically to give the section chat a reset path an errored
// (or stopped) turn never had before: previously ALL sections shared one
// unkeyed useChat instance, so its status/error never cleared on a switch
// or a restart, only on sending a fresh message. These pin that the reset
// actually happens now.
describe("App section chat gains a reset path on switch/restart (#302 review fix)", () => {
  it("clears a section's stale chat-stream error when the student switches away and back, with no new message sent", async () => {
    const twoSections = {
      homeworks: [
        {
          id: "hw-1",
          courseId: "course-a",
          courseName: "STATS 311",
          title: "HW 3",
          description: "d",
          dueDate: "2099-01-01T00:00:00.000Z",
          completedPercentage: 0,
          inProgressPercentage: 0,
          sections: [
            { id: "s1", title: "Sec 1", order: 1, status: "in_progress", conversationId: "sec-conv-1" },
            { id: "s2", title: "Sec 2", order: 2, status: "in_progress", conversationId: "sec-conv-2" },
          ],
        },
      ],
    };
    const historyByConversation: Record<string, unknown[]> = {
      "sec-conv-1": [{ id: "m1", role: "user", parts: [{ type: "text", text: "sec 1 question" }] }],
      "sec-conv-2": [{ id: "m2", role: "user", parts: [{ type: "text", text: "sec 2 question" }] }],
    };
    let chatCallCount = 0;
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
        if (url === "/api/student/homeworks") return new Response(JSON.stringify(twoSections), { status: 200 });
        if (url.startsWith("/api/conversations?")) {
          return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
        }
        if (url.endsWith("/hints")) return new Response(JSON.stringify({ used: 0, limit: null }), { status: 200 });
        const messagesMatch = url.match(/^\/api\/conversations\/([^/]+)\/messages/);
        if (messagesMatch) {
          return new Response(JSON.stringify(historyByConversation[messagesMatch[1]!] ?? []), { status: 200 });
        }
        if (url === "/api/chat") {
          chatCallCount += 1;
          // A response-half failure -- the server accepted the send, so
          // nothing about it should be recoverable by merely switching
          // surfaces (see the streaming-resilience describe above); the
          // point here is only whether the ERROR ROW itself persists.
          return interruptedChatStreamResponse("sec-conv-1", "half an answer");
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

    expect(await screen.findByText("sec 1 question")).toBeTruthy();
    const composer = (await screen.findByLabelText("Message input")) as HTMLTextAreaElement;
    const user = userEvent.setup();
    await user.type(composer, "will this error?{Enter}");
    expect(await screen.findByRole("alert")).toBeTruthy();

    // Switch away, then back -- no new message sent into section 1 at all.
    await user.click(screen.getByRole("button", { name: /Sec 2/ }));
    await screen.findByText("sec 2 question");
    await user.click(screen.getByRole("button", { name: /Sec 1/ }));
    await screen.findByText("sec 1 question");

    // Before #302, the section useChat was one unkeyed instance shared by
    // every section -- this stale error would still be showing here.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(chatCallCount).toBe(1);
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
        if (url.startsWith("/api/conversations?")) return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
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

// #299: two <nav> landmarks (Sidebar, TutorConversationsList) sit between
// the top nav and the chat column with no content landmark for landmark
// navigation to reach -- a skip link plus a <main> around the chat column
// is the standard 2.4.1 Bypass Blocks fix.
describe("App main landmark + skip link (#299)", () => {
  it("wraps the conversation column in a focusable <main id=\"conversation-main\">, reachable from a first-child skip link", async () => {
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
        if (url.startsWith("/api/conversations?")) return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
        throw new Error(`unexpected fetch to ${url}`);
      }),
    );

    const { container } = render(
      <MemoryRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>,
    );

    await screen.findByRole("button", { name: "New conversation" });

    const pageFrame = container.querySelector(".page-frame")!;
    const skipLink = pageFrame.firstElementChild as HTMLAnchorElement;
    expect(skipLink.tagName).toBe("A");
    expect(skipLink.getAttribute("href")).toBe("#conversation-main");
    expect(skipLink.textContent).toMatch(/skip to conversation/i);

    const main = document.getElementById("conversation-main")!;
    expect(main.tagName).toBe("MAIN");
    expect(main.getAttribute("tabindex")).toBe("-1");
  });
});

// #252: the section chat's own version of the #4 hydration invariant --
// resuming a section must hydrate `useChat`'s messages, not just set
// `conversationId`. Setting the id alone leaves the LLM with zero prior
// context on every reload while the server keeps appending to the same,
// real conversation row. Covers both what the section chat SENDS after a
// reload and the visible transcript, since only the first of those catches
// the silent-context-loss half.
describe("App section chat resumes with hydrated history (#252)", () => {
  const HOMEWORK_FIXTURE = {
    homeworks: [
      {
        id: "hw-1",
        courseId: "course-a",
        courseName: "STATS 311",
        title: "HW 3",
        description: "d",
        dueDate: "2099-01-01T00:00:00.000Z",
        completedPercentage: 0,
        inProgressPercentage: 0,
        sections: [
          { id: "s1", title: "Sec 1", order: 1, status: "in_progress", conversationId: "sec-conv-1" },
        ],
      },
    ],
  };

  it("hydrates the section chat's transcript on mount AND includes the prior turns in the next /api/chat request", async () => {
    vi.stubGlobal("CSS", { supports: () => true });
    Element.prototype.scrollIntoView = vi.fn();

    const chatCalls: Array<{ conversationId?: string; messages: Array<{ role: string }> }> = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/profile") return new Response(JSON.stringify({}), { status: 200 });
        if (url === "/api/hello") {
          return new Response(JSON.stringify({ message: "ok", ping_id: "1".repeat(8) }), { status: 200 });
        }
        if (url === "/api/student/homeworks") return new Response(JSON.stringify(HOMEWORK_FIXTURE), { status: 200 });
        if (url.startsWith("/api/conversations?")) return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
        if (url.startsWith("/api/conversations/sec-conv-1/messages")) {
          return new Response(
            JSON.stringify([
              { id: "m1", role: "user", parts: [{ type: "text", text: "prior section question" }] },
              { id: "m2", role: "assistant", parts: [{ type: "text", text: "prior section answer" }] },
            ]),
            { status: 200 },
          );
        }
        if (url === "/api/chat") {
          const body = JSON.parse(String(init?.body)) as {
            conversationId?: string;
            messages: Array<{ role: string }>;
          };
          chatCalls.push(body);
          return chatStreamResponse(body.conversationId ?? "unexpected", "follow-up section reply");
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

    // The visible transcript reflects the persisted history on mount, not
    // an empty thread -- the other half of #252 (the model's context is
    // the part the test below actually proves).
    expect(await screen.findByText("prior section question")).toBeTruthy();
    expect(await screen.findByText("prior section answer")).toBeTruthy();

    const composer = await screen.findByLabelText("Message input");
    const user = userEvent.setup();
    await user.type(composer, "follow-up section question{Enter}");
    await screen.findByText("follow-up section reply");

    expect(chatCalls).toHaveLength(1);
    expect(chatCalls[0]!.conversationId).toBe("sec-conv-1");
    // #317 review, blocking finding #3: wire body trimmed to just the
    // message just typed -- identical rationale to the tutor rail's own
    // regression test above.
    expect(chatCalls[0]!.messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("switching from a hydrated section back to it after visiting another surface re-hydrates rather than staying empty", async () => {
    vi.stubGlobal("CSS", { supports: () => true });
    Element.prototype.scrollIntoView = vi.fn();

    const twoSectionFixture = {
      homeworks: [
        {
          ...HOMEWORK_FIXTURE.homeworks[0],
          sections: [
            { id: "s1", title: "Sec 1", order: 1, status: "in_progress", conversationId: "sec-conv-1" },
            { id: "s2", title: "Sec 2", order: 2, status: "not_started", conversationId: null },
          ],
        },
      ],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/profile") return new Response(JSON.stringify({}), { status: 200 });
        if (url === "/api/hello") {
          return new Response(JSON.stringify({ message: "ok", ping_id: "1".repeat(8) }), { status: 200 });
        }
        if (url === "/api/student/homeworks") return new Response(JSON.stringify(twoSectionFixture), { status: 200 });
        if (url.startsWith("/api/conversations?")) return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
        if (url.startsWith("/api/conversations/sec-conv-1/messages")) {
          return new Response(
            JSON.stringify([{ id: "m1", role: "user", parts: [{ type: "text", text: "sec 1 question" }] }]),
            { status: 200 },
          );
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

    // Sec 1 auto-selected on mount, hydrated.
    expect(await screen.findByText("sec 1 question")).toBeTruthy();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Sec 2/ }));
    // Sec 2 has no conversation yet -- empty thread, not sec 1's leftover text.
    expect(screen.queryByText("sec 1 question")).toBeNull();

    await user.click(screen.getByRole("button", { name: /Sec 1/ }));
    // Back on sec 1 -- re-hydrated, not left empty from sec 2's clear.
    expect(await screen.findByText("sec 1 question")).toBeTruthy();
  });

  it("re-selecting the section already on screen still applies freshly fetched history, not the stale transcript it already had (#302 review fix, Critical #2)", async () => {
    /* Sidebar's onSelect has no already-current guard (App.tsx's
       handleSectionSelect always runs loadSectionConversation, even for the
       section already showing) -- clicking the SAME section twice produces
       the IDENTICAL sectionChatKey both times (`${sectionNumber}:
       ${conversationId}` is unchanged, since neither the section nor its
       conversationId changed). useConversationSurface's `messages` option
       is only consulted when the key ACTUALLY changes (that's what makes a
       genuine switch reset the Chat instance); with an unchanged key, a
       first #302 draft's `selectSectionConversation` wrote only the seed
       state and never the LIVE instance, so this second fetch's content
       was silently dropped and the stale first-fetch transcript stayed on
       screen forever. */
    const homework = {
      homeworks: [
        {
          id: "hw-1",
          courseId: "course-a",
          courseName: "STATS 311",
          title: "HW 3",
          description: "d",
          dueDate: "2099-01-01T00:00:00.000Z",
          completedPercentage: 0,
          inProgressPercentage: 0,
          sections: [{ id: "s1", title: "Sec 1", order: 1, status: "in_progress", conversationId: "sec-conv-1" }],
        },
      ],
    };
    let messagesCallCount = 0;
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
        if (url === "/api/student/homeworks") return new Response(JSON.stringify(homework), { status: 200 });
        if (url.startsWith("/api/conversations?")) {
          return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
        }
        if (url.endsWith("/hints")) return new Response(JSON.stringify({ used: 0, limit: null }), { status: 200 });
        if (url.startsWith("/api/conversations/sec-conv-1/messages")) {
          messagesCallCount += 1;
          const text = messagesCallCount === 1 ? "first fetch content" : "second fetch content, added since";
          return new Response(
            JSON.stringify([{ id: `m${messagesCallCount}`, role: "user", parts: [{ type: "text", text }] }]),
            { status: 200 },
          );
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

    expect(await screen.findByText("first fetch content")).toBeTruthy();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Sec 1/ }));

    expect(await screen.findByText("second fetch content, added since")).toBeTruthy();
    expect(messagesCallCount).toBe(2);
  });
});

describe("App eager section greeting (#318)", () => {
  const HOMEWORK_FIXTURE = {
    homeworks: [
      {
        id: "hw-1",
        courseId: "course-a",
        courseName: "STATS 311",
        title: "HW 3",
        description: "d",
        dueDate: "2099-01-01T00:00:00.000Z",
        completedPercentage: 0,
        inProgressPercentage: 0,
        sections: [{ id: "s1", title: "Sec 1", order: 1, status: "not_started", conversationId: null }],
      },
    ],
  };

  it("shows the section's greeting on open, before the student sends anything", async () => {
    vi.stubGlobal("CSS", { supports: () => true });
    Element.prototype.scrollIntoView = vi.fn();

    let startCalls = 0;
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
          return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
        }
        if (url === "/api/courses/course-a/sections/s1/conversations" && init?.method === "POST") {
          startCalls += 1;
          return new Response(
            JSON.stringify({
              id: "sec-conv-new",
              title: "Section 1: Sec 1",
              greetingMessageId: "g1",
              greetingParts: [
                {
                  type: "text",
                  // Full multi-line shape the server now produces (sectionGreeting).
                  // It no longer repeats the "Section 1: Sec 1" heading: the
                  // breadcrumb above the transcript already renders that string
                  // verbatim, so the greeting opens on the content instead.
                  text:
                    "What is a mean?\n\nWhere would you like to start? If you already have an idea, tell me what you're thinking and we'll work from there.",
                },
              ],
              promptTemplateId: null,
            }),
            { status: 201 },
          );
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

    // No message sent yet -- the greeting must already be visible.
    expect(await screen.findByText(/Where would you like to start\?/)).toBeTruthy();
    expect(startCalls).toBe(1);
    // The sidebar dot must reflect the new conversation too, not stay
    // "not_started" until a reload -- SectionItem marks the current section
    // aria-current="step" only once its status flips to "current".
    expect(screen.getByRole("button", { name: /Sec 1/ }).getAttribute("aria-current")).toBe("step");
  });

  it("shows the eager greeting even when its own POST resolves AFTER React has already applied sectionChatKey's first-ever transition (#302 review fix, Important #1c)", async () => {
    /* startFreshSectionConversation kicks off this POST in the SAME
       synchronous tick as loadSectionConversation's own FIRST-EVER
       sectionChatKey assignment (undefined -> a real key) -- by the time
       an awaited fetch resolves, React may or may not have already
       flushed that queued render. A first #302 draft only wrote the
       greeting through the LIVE `setMessages`, which is lost the moment a
       still-pending key change lands afterward (it recreates the Chat
       instance, reseeding from whatever `sectionInitialMessages` was at
       THAT render -- still empty). The fix also updates the seed
       (`sectionInitialMessages`) so a recreation landing after this point
       still seeds correctly. Deferring the POST past a macrotask boundary
       (a plain immediately-resolving mock, as the sibling test above uses,
       already tends to resolve BEFORE the render flushes -- this test
       forces the opposite, slower ordering deterministically) exercises
       the other half of that "regardless of which order" claim. */
    vi.stubGlobal("CSS", { supports: () => true });
    Element.prototype.scrollIntoView = vi.fn();

    let startCalls = 0;
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
          return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
        }
        if (url === "/api/courses/course-a/sections/s1/conversations" && init?.method === "POST") {
          startCalls += 1;
          // A macrotask boundary always runs after any microtasks (and
          // React's own render flush) already queued in this tick.
          await new Promise((resolve) => setTimeout(resolve, 0));
          return new Response(
            JSON.stringify({
              id: "sec-conv-new",
              title: "Section 1: Sec 1",
              greetingMessageId: "g1",
              greetingParts: [{ type: "text", text: "Where would you like to start?" }],
              promptTemplateId: null,
            }),
            { status: 201 },
          );
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

    expect(await screen.findByText(/Where would you like to start\?/)).toBeTruthy();
    expect(startCalls).toBe(1);
  });

  it("leaves the composer empty (no crash) when the eager-start call 409s", async () => {
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
          return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
        }
        if (url === "/api/courses/course-a/sections/s1/conversations" && init?.method === "POST") {
          return new Response(JSON.stringify({ error: "Section is not interactive" }), { status: 409 });
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
    expect(composer).toBeTruthy();
    expect(screen.queryByText(/Where would you like to start\?/)).toBeNull();
  });

  it("Submit does nothing for a section whose only content is the eager greeting -- no student turn yet", async () => {
    vi.stubGlobal("CSS", { supports: () => true });
    Element.prototype.scrollIntoView = vi.fn();

    let submitCalls = 0;
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
          return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
        }
        if (url === "/api/courses/course-a/sections/s1/conversations" && init?.method === "POST") {
          return new Response(
            JSON.stringify({
              id: "sec-conv-new",
              title: "Section 1: Sec 1",
              greetingMessageId: "g1",
              greetingParts: [
                {
                  type: "text",
                  // Full multi-line shape the server now produces (sectionGreeting).
                  // It no longer repeats the "Section 1: Sec 1" heading: the
                  // breadcrumb above the transcript already renders that string
                  // verbatim, so the greeting opens on the content instead.
                  text:
                    "What is a mean?\n\nWhere would you like to start? If you already have an idea, tell me what you're thinking and we'll work from there.",
                },
              ],
              promptTemplateId: null,
            }),
            { status: 201 },
          );
        }
        if (url === "/api/conversations/sec-conv-new/submit" && init?.method === "POST") {
          submitCalls += 1;
          return new Response(JSON.stringify({}), { status: 200 });
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

    await screen.findByText(/Where would you like to start\?/);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Submit section 1/i }));

    // Give any (wrongly-fired) submit request a tick to land, then assert
    // it never did -- the greeting alone must not be submittable work.
    await new Promise((r) => setTimeout(r, 0));
    expect(submitCalls).toBe(0);
  });
});

describe("App section conversationId stays live after mid-session creation (#271, #272)", () => {
  const TWO_SECTION_NO_CONVO_FIXTURE = {
    homeworks: [
      {
        id: "hw-1",
        courseId: "course-a",
        courseName: "STATS 311",
        title: "HW 3",
        description: "d",
        dueDate: "2099-01-01T00:00:00.000Z",
        completedPercentage: 0,
        inProgressPercentage: 0,
        sections: [
          { id: "s1", title: "Sec 1", order: 1, status: "not_started", conversationId: null },
          { id: "s2", title: "Sec 2", order: 2, status: "not_started", conversationId: null },
        ],
      },
    ],
  };

  // #271: previously, a section's conversationId learned mid-session (via
  // the x-conversation-id response header on its first turn) was written
  // ONLY into React state local to that turn -- sectionMetaByOrder itself
  // was never updated. Switching away and back re-read the stale (null)
  // map entry, wiped the transcript, and left Submit permanently inert.
  // This drives the real failure path end to end: a section that starts
  // with conversationId: null, gets one, survives a switch-away-and-back,
  // and Submit actually fires against the right id.
  it("keeps a section's transcript and Submit working after its first-ever turn mints a conversationId", async () => {
    vi.stubGlobal("CSS", { supports: () => true });
    Element.prototype.scrollIntoView = vi.fn();

    const submitCalls: string[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/profile") return new Response(JSON.stringify({}), { status: 200 });
        if (url === "/api/hello") {
          return new Response(JSON.stringify({ message: "ok", ping_id: "1".repeat(8) }), { status: 200 });
        }
        if (url === "/api/student/homeworks") {
          return new Response(JSON.stringify(TWO_SECTION_NO_CONVO_FIXTURE), { status: 200 });
        }
        if (url.startsWith("/api/conversations?")) return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
        if (url === "/api/chat") {
          const body = JSON.parse(String(init?.body)) as { conversationId?: string; kind?: string };
          // Only Sec 1's very first turn should ever reach here without a
          // conversationId -- every later call (including the eventual
          // Sec 1 revisit) must already carry "new-conv-1".
          if (!body.conversationId) {
            return chatStreamResponse("new-conv-1", "reply to sec 1");
          }
          throw new Error(`unexpected /api/chat call with body ${JSON.stringify(body)}`);
        }
        if (url.startsWith("/api/conversations/new-conv-1/messages")) {
          return new Response(
            JSON.stringify([
              { id: "m1", role: "user", parts: [{ type: "text", text: "hello sec1" }] },
              { id: "m2", role: "assistant", parts: [{ type: "text", text: "reply to sec 1" }] },
            ]),
            { status: 200 },
          );
        }
        if (url === "/api/conversations/new-conv-1/submit" && init?.method === "POST") {
          submitCalls.push(url);
          return new Response(JSON.stringify({}), { status: 200 });
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
    await user.type(composer, "hello sec1{Enter}");
    await screen.findByText("reply to sec 1");

    // Switch away, then back -- this is the exact path that was broken:
    // sectionMetaByOrder must now report "new-conv-1" for Sec 1, not the
    // null it started with.
    await user.click(screen.getByRole("button", { name: /Sec 2/ }));
    expect(screen.queryByText("reply to sec 1")).toBeNull();
    await user.click(screen.getByRole("button", { name: /Sec 1/ }));
    // Re-hydrated via /api/conversations/new-conv-1/messages -- proves the
    // switch-back resolved the UPDATED id, not the original null (which
    // would have cleared to an empty thread instead of re-fetching).
    expect(await screen.findByText("reply to sec 1")).toBeTruthy();

    // Submit must fire against "new-conv-1" -- previously silently
    // no-op'd because handleSubmit read sections[].conversationId, a copy
    // that was never updated past its initial (null) fetch.
    await user.click(screen.getByRole("button", { name: /Submit section 1/i }));
    await waitFor(() => expect(submitCalls).toEqual(["/api/conversations/new-conv-1/submit"]));
  });

  // Round-4 review finding: the test above only drives the #271 half (a
  // section switch away-and-back). It asserts nothing about #272's own
  // claim -- that the greeting re-hydration effect replaces the in-session
  // transcript with [greeting, question, reply] once the creation turn's
  // stream finishes, WITHOUT requiring a section switch or reload. That
  // effect gates on `latestSectionConversationRef.current === pendingId`,
  // and nothing on the "section starts at conversationId: null" path ever
  // wrote the newly-minted id into that ref (it's only set by
  // loadSectionConversation, last called with `undefined` for a fresh
  // section) -- so the guard always failed, the re-fetch fired and was
  // discarded, and the greeting never appeared until a switch or reload
  // re-ran loadSectionConversation from scratch. This drives exactly that
  // path: one turn, no section switch, and asserts the greeting is visible
  // afterward.
  it("shows the section's greeting in the transcript right after its first-ever turn, with no section switch (#272)", async () => {
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
        if (url === "/api/student/homeworks") {
          return new Response(JSON.stringify(TWO_SECTION_NO_CONVO_FIXTURE), { status: 200 });
        }
        if (url.startsWith("/api/conversations?")) return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
        if (url === "/api/chat") {
          const body = JSON.parse(String(init?.body)) as { conversationId?: string };
          if (!body.conversationId) return chatStreamResponse("new-conv-1", "reply to sec 1");
          throw new Error(`unexpected /api/chat call with body ${JSON.stringify(body)}`);
        }
        if (url.startsWith("/api/conversations/new-conv-1/messages")) {
          return new Response(
            JSON.stringify([
              { id: "g1", role: "assistant", parts: [{ type: "text", text: "section greeting text" }] },
              { id: "m1", role: "user", parts: [{ type: "text", text: "hello sec1" }] },
              { id: "m2", role: "assistant", parts: [{ type: "text", text: "reply to sec 1" }] },
            ]),
            { status: 200 },
          );
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
    await user.type(composer, "hello sec1{Enter}");
    await screen.findByText("reply to sec 1");

    // No section switch, no reload -- the re-hydration effect alone must
    // surface the greeting once the creation turn's stream settles.
    expect(await screen.findByText("section greeting text")).toBeTruthy();
  });
});

// #276: a hydration failure used to fail OPEN -- clear the message list to
// [] with no error and nothing disabled, so the very next thing typed went
// to the model with zero context and got persisted into the real
// conversation. Both the tutor and section paths must now fail CLOSED:
// leave the message list alone, surface a retryable error, and disable the
// composer while it's broken.
describe("App history hydration fails closed on fetch failure (#276)", () => {
  const HOMEWORK_FIXTURE = {
    homeworks: [
      {
        id: "hw-1",
        courseId: "course-a",
        courseName: "STATS 311",
        title: "HW 3",
        description: "d",
        dueDate: "2099-01-01T00:00:00.000Z",
        completedPercentage: 0,
        inProgressPercentage: 0,
        sections: [
          { id: "s1", title: "Sec 1", order: 1, status: "in_progress", conversationId: "sec-conv-1" },
        ],
      },
    ],
  };

  it("section chat: a failed history fetch does not clear the transcript, surfaces a retryable error, and disables the composer", async () => {
    vi.stubGlobal("CSS", { supports: () => true });
    Element.prototype.scrollIntoView = vi.fn();

    let messagesCallCount = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/profile") return new Response(JSON.stringify({}), { status: 200 });
        if (url === "/api/hello") {
          return new Response(JSON.stringify({ message: "ok", ping_id: "1".repeat(8) }), { status: 200 });
        }
        if (url === "/api/student/homeworks") return new Response(JSON.stringify(HOMEWORK_FIXTURE), { status: 200 });
        if (url.startsWith("/api/conversations?")) return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
        if (url.startsWith("/api/conversations/sec-conv-1/messages")) {
          messagesCallCount += 1;
          return new Response(JSON.stringify({ error: "server unavailable" }), { status: 503 });
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

    // Retryable error surfaced, not a silent empty thread.
    expect(await screen.findByText(/Couldn't load this section's conversation/i)).toBeTruthy();
    // Composer disabled while hydration is broken -- a context-free turn
    // must not be sendable into the real conversation.
    const composer = (await screen.findByLabelText("Message input")) as HTMLTextAreaElement;
    expect(isComposerDisabled(composer)).toBe(true);
    expect(messagesCallCount).toBe(1);

    // Retry re-attempts the same fetch (still fails here -- proving Retry
    // is wired to the real fetch, not a no-op).
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(messagesCallCount).toBe(2));
  });

  it("tutor chat: a failed history fetch surfaces a retryable error and disables the composer instead of a silent empty thread", async () => {
    vi.stubGlobal("CSS", { supports: () => true });
    Element.prototype.scrollIntoView = vi.fn();

    const tutorFixture = {
      homeworks: [{ ...HOMEWORK_FIXTURE.homeworks[0], sections: [] }],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/profile") return new Response(JSON.stringify({}), { status: 200 });
        if (url === "/api/hello") {
          return new Response(JSON.stringify({ message: "ok", ping_id: "1".repeat(8) }), { status: 200 });
        }
        if (url === "/api/student/homeworks") return new Response(JSON.stringify(tutorFixture), { status: 200 });
        if (url.startsWith("/api/conversations?courseId=")) {
          return new Response(
            JSON.stringify({
              items: [
                { id: "t1", title: "Existing tutor chat", updatedAt: "2026-01-01T00:00:00.000Z", messageCount: 2 },
              ],
              nextCursor: null,
            }),
            { status: 200 },
          );
        }
        if (url.startsWith("/api/conversations/t1/messages")) {
          return new Response(JSON.stringify({ error: "server unavailable" }), { status: 503 });
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

    const user = userEvent.setup();
    await user.click(await screen.findByText("Existing tutor chat"));

    // Switches to the tutor surface (ConversationView only mounts for the
    // currently-selected id, so that's where the error row has to render)
    // but with the retryable error attached, not a silent empty thread.
    expect(await screen.findByText("TUTOR CHAT")).toBeTruthy();
    expect(await screen.findByText(/Couldn't load that conversation/i)).toBeTruthy();
    const composer = (await screen.findByLabelText("Message input")) as HTMLTextAreaElement;
    expect(isComposerDisabled(composer)).toBe(true);
  });

  it("tutor chat: creating a new conversation clears a stale hydration error from the previous one", async () => {
    /* Final review: handleCreateTutorConversation resets the pagination
       state a prior conversation left behind (the test above this describe
       block), but tutorHydrationError is the same kind of per-conversation
       state and was missed in that pass -- it is cleared on select (line
       ~918) and on delete-of-displayed (~1073), but not on create. Without
       this reset, creating a conversation while an earlier one's hydration
       had failed left the brand-new conversation rendered with t1's stale
       error: composer disabled (isSending checks tutorHydrationError) and a
       Retry that closes over t1's id, not t2's. */
    vi.stubGlobal("CSS", { supports: () => true });
    Element.prototype.scrollIntoView = vi.fn();

    const tutorFixture = {
      homeworks: [{ ...HOMEWORK_FIXTURE.homeworks[0], sections: [] }],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/profile") return new Response(JSON.stringify({}), { status: 200 });
        if (url === "/api/hello") {
          return new Response(JSON.stringify({ message: "ok", ping_id: "1".repeat(8) }), { status: 200 });
        }
        if (url === "/api/student/homeworks") return new Response(JSON.stringify(tutorFixture), { status: 200 });
        if (url === "/api/conversations" && init?.method === "POST") {
          return new Response(
            JSON.stringify({
              id: "t2",
              kind: "tutor",
              title: "New conversation",
              createdAt: "2026-01-03T00:00:00.000Z",
              updatedAt: "2026-01-03T00:00:00.000Z",
            }),
            { status: 201 },
          );
        }
        if (url.startsWith("/api/conversations?courseId=")) {
          return new Response(
            JSON.stringify({
              items: [
                { id: "t1", title: "Existing tutor chat", updatedAt: "2026-01-01T00:00:00.000Z", messageCount: 2 },
              ],
              nextCursor: null,
            }),
            { status: 200 },
          );
        }
        if (url.startsWith("/api/conversations/t1/messages")) {
          return new Response(JSON.stringify({ error: "server unavailable" }), { status: 503 });
        }
        if (url.startsWith("/api/conversations/t2/messages")) {
          return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
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

    const user = userEvent.setup();
    await user.click(await screen.findByText("Existing tutor chat"));
    expect(await screen.findByText(/Couldn't load that conversation/i)).toBeTruthy();
    const composerBefore = (await screen.findByLabelText("Message input")) as HTMLTextAreaElement;
    expect(isComposerDisabled(composerBefore)).toBe(true);

    await user.click(screen.getByRole("button", { name: /new conversation/i }));

    // t2 has nothing wrong with it -- t1's error must not have survived.
    await waitFor(() => expect(screen.queryByText(/Couldn't load that conversation/i)).toBeNull());
    const composerAfter = (await screen.findByLabelText("Message input")) as HTMLTextAreaElement;
    expect(isComposerDisabled(composerAfter)).toBe(false);
  });
});

// #248: the section chat's restart affordance -- confirm dialog copy,
// wiring to POST .../conversations/:id/restart, and hydrating the
// replacement conversation on success. Reuses HOMEWORK_FIXTURE's shape.
describe("App section restart affordance (#248)", () => {
  const RESTART_HOMEWORK_FIXTURE = {
    homeworks: [
      {
        id: "hw-1",
        courseId: "course-a",
        courseName: "STATS 311",
        title: "HW 3",
        description: "d",
        dueDate: "2099-01-01T00:00:00.000Z",
        completedPercentage: 0,
        inProgressPercentage: 0,
        sections: [
          { id: "s1", title: "Sec 1", order: 1, status: "in_progress", conversationId: "sec-conv-1" },
        ],
      },
    ],
  };

  function stubBaseFetch(
    extra: (url: string, init?: RequestInit) => Response | null,
  ) {
    vi.stubGlobal("CSS", { supports: () => true });
    Element.prototype.scrollIntoView = vi.fn();
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/profile") return new Response(JSON.stringify({}), { status: 200 });
        if (url === "/api/hello") {
          return new Response(JSON.stringify({ message: "ok", ping_id: "1".repeat(8) }), { status: 200 });
        }
        if (url === "/api/student/homeworks") {
          return new Response(JSON.stringify(RESTART_HOMEWORK_FIXTURE), { status: 200 });
        }
        if (url.startsWith("/api/conversations?")) return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
        if (url.startsWith("/api/conversations/sec-conv-1/messages")) {
          return new Response(
            JSON.stringify([{ id: "m1", role: "user", parts: [{ type: "text", text: "sec 1 question" }] }]),
            { status: 200 },
          );
        }
        const res = extra(url, init);
        if (res) return res;
        throw new Error(`unexpected fetch to ${url}`);
      }),
    );
  }

  it("does not render the restart button for a section with no active conversation", async () => {
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
        if (url === "/api/student/homeworks") {
          return new Response(
            JSON.stringify({
              homeworks: [
                {
                  ...RESTART_HOMEWORK_FIXTURE.homeworks[0],
                  sections: [{ id: "s1", title: "Sec 1", order: 1, status: "not_started", conversationId: null }],
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.startsWith("/api/conversations?")) return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
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

    await screen.findByLabelText("Message input");
    expect(screen.queryByRole("button", { name: "Restart section" })).toBeNull();
  });

  it("opens a confirm dialog stating the conversation won't be recoverable, and cancel leaves it untouched", async () => {
    stubBaseFetch(() => null);

    render(
      <MemoryRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>,
    );

    const restartButton = await screen.findByRole("button", { name: "Restart section" });
    const user = userEvent.setup();
    await user.click(restartButton);

    const dialog = await screen.findByRole("alertdialog", { name: "Restart this section?" });
    expect(dialog.textContent).toContain("you won't be able to see it again");
    // Not submitted -- no "submission will be undone" line.
    expect(dialog.textContent).not.toContain("submission for this section will be undone");

    await user.click(screen.getByRole("button", { name: "Keep this conversation" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    // Original conversation untouched.
    expect(await screen.findByText("sec 1 question")).toBeTruthy();
  });

  it("shows the submission-will-be-undone line when the section is already submitted", async () => {
    vi.stubGlobal("CSS", { supports: () => true });
    Element.prototype.scrollIntoView = vi.fn();
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/profile") return new Response(JSON.stringify({}), { status: 200 });
        if (url === "/api/hello") {
          return new Response(JSON.stringify({ message: "ok", ping_id: "1".repeat(8) }), { status: 200 });
        }
        if (url === "/api/student/homeworks") {
          return new Response(
            JSON.stringify({
              homeworks: [
                {
                  ...RESTART_HOMEWORK_FIXTURE.homeworks[0],
                  sections: [{ id: "s1", title: "Sec 1", order: 1, status: "submitted", conversationId: "sec-conv-1" }],
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.startsWith("/api/conversations?")) return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
        if (url.startsWith("/api/conversations/sec-conv-1/messages")) {
          return new Response(
            JSON.stringify([{ id: "m1", role: "user", parts: [{ type: "text", text: "sec 1 question" }] }]),
            { status: 200 },
          );
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

    const restartButton = await screen.findByRole("button", { name: "Restart section" });
    const user = userEvent.setup();
    await user.click(restartButton);

    const dialog = await screen.findByRole("alertdialog", { name: "Restart this section?" });
    expect(dialog.textContent).toContain("submission for this section will be undone");
  });

  it("confirming restart POSTs to the restart endpoint and hydrates the replacement conversation", async () => {
    let restartCalled = false;
    stubBaseFetch((url) => {
      if (url === "/api/courses/course-a/conversations/sec-conv-1/restart") {
        restartCalled = true;
        return new Response(
          JSON.stringify({
            conversation: { id: "sec-conv-2", title: "Section 1: Sec 1", greetingMessageId: "g1" },
            voidedSubmission: null,
          }),
          { status: 201 },
        );
      }
      if (url.startsWith("/api/conversations/sec-conv-2/messages")) {
        return new Response(
          JSON.stringify([{ id: "g1", role: "assistant", parts: [{ type: "text", text: "fresh greeting" }] }]),
          { status: 200 },
        );
      }
      return null;
    });

    render(
      <MemoryRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>,
    );

    const restartButton = await screen.findByRole("button", { name: "Restart section" });
    const user = userEvent.setup();
    await user.click(restartButton);
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Restart section" }));

    expect(await screen.findByText("fresh greeting")).toBeTruthy();
    expect(restartCalled).toBe(true);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByText("sec 1 question")).toBeNull();
  });

  it("clears an errored section chat's error row after a restart (#302 review fix, Important #1a)", async () => {
    /* Restart mints a genuinely different conversation for the SAME section
       number -- before #302, the section useChat was one unkeyed instance
       shared by all sections, so restart re-hydrated its MESSAGES but never
       reset its status/error: a stale error from before the restart would
       still show alongside the fresh greeting. #302's sectionChatKey is
       derived from `${sectionNumber}:${conversationId}`, so restart (a new
       conversationId for the same section) changes the key too, giving this
       the same reset a plain section switch gets (see the describe block
       above). */
    let restartCalled = false;
    let chatCallCount = 0;
    stubBaseFetch((url) => {
      if (url === "/api/chat") {
        chatCallCount += 1;
        return interruptedChatStreamResponse("sec-conv-1", "half an answer");
      }
      if (url === "/api/courses/course-a/conversations/sec-conv-1/restart") {
        restartCalled = true;
        return new Response(
          JSON.stringify({
            conversation: { id: "sec-conv-2", title: "Section 1: Sec 1", greetingMessageId: "g1" },
            voidedSubmission: null,
          }),
          { status: 201 },
        );
      }
      if (url.startsWith("/api/conversations/sec-conv-2/messages")) {
        return new Response(
          JSON.stringify([{ id: "g1", role: "assistant", parts: [{ type: "text", text: "fresh greeting" }] }]),
          { status: 200 },
        );
      }
      return null;
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
    await user.type(composer, "will this error?{Enter}");
    expect(await screen.findByRole("alert")).toBeTruthy();

    const restartButton = await screen.findByRole("button", { name: "Restart section" });
    await user.click(restartButton);
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Restart section" }));

    expect(await screen.findByText("fresh greeting")).toBeTruthy();
    expect(restartCalled).toBe(true);
    // Before #302, this stale alert would still be showing next to the
    // fresh greeting.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(chatCallCount).toBe(1);
  });

  it("a 409 (graded submission) keeps the dialog open and shows the server's message inline", async () => {
    stubBaseFetch((url) => {
      if (url === "/api/courses/course-a/conversations/sec-conv-1/restart") {
        return new Response(
          JSON.stringify({ error: "Submission has already been graded and cannot be restarted" }),
          { status: 409 },
        );
      }
      return null;
    });

    render(
      <MemoryRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>,
    );

    const restartButton = await screen.findByRole("button", { name: "Restart section" });
    const user = userEvent.setup();
    await user.click(restartButton);
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Restart section" }));

    const errorText = await screen.findByText("Submission has already been graded and cannot be restarted");
    expect(errorText).toBeTruthy();
    // Dialog stayed open -- the original conversation is untouched.
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });
});

// #274: a client-side Stop control for a turn that's merely slow, not yet
// timed out server-side. Uses a manually-controlled SSE stream (never
// closed on its own) so the request stays genuinely in flight long enough
// to assert the button, then click it.
describe("App Stop control (#274)", () => {
  const STOP_HOMEWORK_FIXTURE = {
    homeworks: [
      {
        id: "hw-1",
        courseId: "course-a",
        courseName: "STATS 311",
        title: "HW 3",
        description: "d",
        dueDate: "2099-01-01T00:00:00.000Z",
        completedPercentage: 0,
        inProgressPercentage: 0,
        sections: [{ id: "s1", title: "Sec 1", order: 1, status: "not_started", conversationId: null }],
      },
    ],
  };

  it("section chat: shows Stop while a turn is in flight, and clicking it aborts the request", async () => {
    vi.stubGlobal("CSS", { supports: () => true });
    Element.prototype.scrollIntoView = vi.fn();

    let capturedSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/profile") return new Response(JSON.stringify({}), { status: 200 });
        if (url === "/api/hello") {
          return new Response(JSON.stringify({ message: "ok", ping_id: "1".repeat(8) }), { status: 200 });
        }
        if (url === "/api/student/homeworks") {
          return new Response(JSON.stringify(STOP_HOMEWORK_FIXTURE), { status: 200 });
        }
        if (url.startsWith("/api/conversations?")) {
          return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
        }
        if (url === "/api/chat") {
          capturedSignal = init?.signal ?? undefined;
          // Never-closing stream -- chatStatus stays "streaming" until the
          // test itself aborts it, same as a genuinely stalled upstream.
          // Wired to the request's own AbortSignal the same way a real
          // fetch's body stream would be: aborting cancels the in-progress
          // read, which is what lets useChat notice Stop actually happened.
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "start" })}\n\n`));
              capturedSignal?.addEventListener("abort", () => {
                controller.error(new DOMException("The operation was aborted.", "AbortError"));
              });
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { "content-type": "text/event-stream", "x-conversation-id": "conv-1" },
          });
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
    await user.type(composer, "hello{Enter}");

    const stopButton = await screen.findByRole("button", { name: "Stop" });
    expect(capturedSignal?.aborted).toBe(false);

    await user.click(stopButton);
    expect(capturedSignal?.aborted).toBe(true);
    // Stop's whole point: the composer must come back, not stay wedged
    // behind isSending forever.
    //
    // #317 review, #327: the control must not be destroyed once isSending
    // goes false -- a keyboard user who just activated it must not have focus
    // dropped to document.body with nothing to restore it. #274 redesign: it
    // reverts to its Send identity in place (same element, see
    // ConversationView.test.tsx's node-identity test), so the assertion is
    // that it is still here and now offers Send rather than a dead Stop.
    // The composer re-enabling is the real assertion the old "Stop unmounts"
    // check stood in for.
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBe(stopButton));
    expect(composer.getAttribute("aria-disabled")).toBe("false");
  });

  // #317 review, #352 (requirement 1): server-side, chat.ts never persists
  // this exact partial (hasRenderableContent/isErrorOutcome, #342) -- the
  // visible transcript must say so instead of the fragment quietly reading
  // as an ordinary, complete, remembered reply.
  it("section chat: marks the partial reply as stopped/not-saved once Stop is clicked mid-stream", async () => {
    vi.stubGlobal("CSS", { supports: () => true });
    Element.prototype.scrollIntoView = vi.fn();

    let capturedSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/profile") return new Response(JSON.stringify({}), { status: 200 });
        if (url === "/api/hello") {
          return new Response(JSON.stringify({ message: "ok", ping_id: "1".repeat(8) }), { status: 200 });
        }
        if (url === "/api/student/homeworks") {
          return new Response(JSON.stringify(STOP_HOMEWORK_FIXTURE), { status: 200 });
        }
        if (url.startsWith("/api/conversations?")) {
          return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
        }
        if (url === "/api/chat") {
          capturedSignal = init?.signal ?? undefined;
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "start" })}\n\n`));
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "start-step" })}\n\n`));
              controller.enqueue(
                new TextEncoder().encode(`data: ${JSON.stringify({ type: "text-start", id: "t1" })}\n\n`),
              );
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({ type: "text-delta", id: "t1", delta: "Here is half of a" })}\n\n`,
                ),
              );
              // No text-end, no finish -- the reply is genuinely mid-stream
              // when Stop fires below.
              capturedSignal?.addEventListener("abort", () => {
                controller.error(new DOMException("The operation was aborted.", "AbortError"));
              });
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { "content-type": "text/event-stream", "x-conversation-id": "conv-1" },
          });
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
    await user.type(composer, "hello{Enter}");

    await screen.findByText("Here is half of a");
    const stopButton = await screen.findByRole("button", { name: "Stop" });
    await user.click(stopButton);

    await screen.findByText(/You stopped this response\. It wasn.t saved, so the tutor won.t remember it\./);
    // The partial text itself must still be visible -- the note is
    // additive (a trailing line), not a replacement of what was on screen.
    // getByText throws if the element isn't present, which is the
    // assertion here (no jest-dom matchers configured in this project).
    screen.getByText("Here is half of a");
  });

  // #317 review, #352 (requirement 3): sectionHydrationError previously
  // forced isSending true (so the composer stays disabled through it, which
  // is correct), which ALSO made the Stop button render as active -- even
  // though no turn is in flight and clicking it would be a no-op. Proves
  // isStopActionable decouples the two: Stop stays aria-disabled while a
  // hydration error is the only thing "sending".
  it("section chat: Stop stays inactive when only a hydration error (not a genuine send) makes the composer disabled", async () => {
    vi.stubGlobal("CSS", { supports: () => true });
    Element.prototype.scrollIntoView = vi.fn();

    const homeworkWithStartedSection = {
      homeworks: [
        {
          ...STOP_HOMEWORK_FIXTURE.homeworks[0],
          sections: [{ id: "s1", title: "Sec 1", order: 1, status: "in_progress", conversationId: "conv-1" }],
        },
      ],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/profile") return new Response(JSON.stringify({}), { status: 200 });
        if (url === "/api/hello") {
          return new Response(JSON.stringify({ message: "ok", ping_id: "1".repeat(8) }), { status: 200 });
        }
        if (url === "/api/student/homeworks") {
          return new Response(JSON.stringify(homeworkWithStartedSection), { status: 200 });
        }
        if (url.startsWith("/api/conversations?")) {
          return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
        }
        // The section already has a conversationId, so App.tsx eagerly
        // hydrates its history on mount -- failing that fetch is what sets
        // sectionHydrationError without any chat turn ever having been sent.
        if (url === "/api/conversations/conv-1/messages?limit=200") {
          return new Response(JSON.stringify({ error: "boom" }), { status: 503 });
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
    // The hydration failure disables the composer -- confirms isSending
    // really is true here, so the Stop assertion below is meaningful and
    // not just "Stop was never rendered."
    await waitFor(() => expect(composer.getAttribute("aria-disabled")).toBe("true"));

    // #274 redesign: with nothing genuinely in flight the trailing action
    // never takes on its Stop identity at all, which is a stronger statement
    // than the old "a Stop button exists but is aria-disabled".
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.getByRole("button", { name: "Send" }).getAttribute("aria-disabled")).toBe("true");
  });
});

// #80: real hint state end-to-end at the App level -- Sidebar's hintCount
// reads from the server (replacing the #20 fixture), and the "Give me a
// hint" button (Composer.tsx) sends a chat turn flagged isHintRequest.
describe("App hint state (#80)", () => {
  const HOMEWORK_FIXTURE = {
    homeworks: [
      {
        id: "hw-1",
        courseId: "course-a",
        courseName: "STATS 311",
        title: "HW 3",
        description: "d",
        dueDate: "2099-01-01T00:00:00.000Z",
        completedPercentage: 0,
        inProgressPercentage: 0,
        sections: [
          { id: "s1", title: "Sec 1", order: 1, status: "in_progress", conversationId: "sec-conv-1" },
        ],
      },
    ],
  };

  it("Sidebar's hint count comes from GET .../hints, not a fixture, and updates after a granted hint request", async () => {
    vi.stubGlobal("CSS", { supports: () => true });
    Element.prototype.scrollIntoView = vi.fn();

    let hintsGetCount = 0;
    const chatCalls: Array<{ isHintRequest?: boolean }> = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/profile") return new Response(JSON.stringify({}), { status: 200 });
        if (url === "/api/hello") {
          return new Response(JSON.stringify({ message: "ok", ping_id: "1".repeat(8) }), { status: 200 });
        }
        if (url === "/api/student/homeworks") return new Response(JSON.stringify(HOMEWORK_FIXTURE), { status: 200 });
        if (url.startsWith("/api/conversations?")) return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
        if (url.startsWith("/api/conversations/sec-conv-1/messages")) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        if (url === "/api/courses/course-a/sections/s1/hints") {
          hintsGetCount++;
          // Second GET (after the hint request settles) reflects the grant.
          const body = hintsGetCount === 1 ? { count: 1, limit: 3, remaining: 2 } : { count: 2, limit: 3, remaining: 1 };
          return new Response(JSON.stringify(body), { status: 200 });
        }
        if (url === "/api/chat") {
          const body = JSON.parse(String(init?.body)) as { isHintRequest?: boolean };
          chatCalls.push(body);
          return chatStreamResponse("sec-conv-1", "scaffolded nudge");
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

    // Real server state (1), not the old fixture's hardcoded 3.
    await waitFor(() => expect(screen.getByLabelText("1 hints used")).toBeTruthy());

    const hintButton = await screen.findByRole("button", { name: "Give me a hint" });
    const user = userEvent.setup();
    await user.click(hintButton);

    await screen.findByText("scaffolded nudge");
    expect(chatCalls).toHaveLength(1);
    expect(chatCalls[0]!.isHintRequest).toBe(true);

    // The count refetch fired once the turn settled, and reflects the grant.
    await waitFor(() => expect(screen.getByLabelText("2 hints used")).toBeTruthy());
    expect(hintsGetCount).toBeGreaterThanOrEqual(2);
  });

  it("rapid double-clicks on 'Give me a hint' send only one chat request (client-side suppression)", async () => {
    vi.stubGlobal("CSS", { supports: () => true });
    Element.prototype.scrollIntoView = vi.fn();

    const chatCalls: unknown[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/profile") return new Response(JSON.stringify({}), { status: 200 });
        if (url === "/api/hello") {
          return new Response(JSON.stringify({ message: "ok", ping_id: "1".repeat(8) }), { status: 200 });
        }
        if (url === "/api/student/homeworks") return new Response(JSON.stringify(HOMEWORK_FIXTURE), { status: 200 });
        if (url.startsWith("/api/conversations?")) return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
        if (url.startsWith("/api/conversations/sec-conv-1/messages")) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        if (url === "/api/courses/course-a/sections/s1/hints") {
          return new Response(JSON.stringify({ count: 0, limit: null, remaining: null }), { status: 200 });
        }
        if (url === "/api/chat") {
          chatCalls.push(JSON.parse(String(init?.body)));
          return chatStreamResponse("sec-conv-1", "reply");
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

    const hintButton = await screen.findByRole("button", { name: "Give me a hint" });
    const user = userEvent.setup();
    // Two rapid clicks, well within HINT_DOUBLE_SUBMIT_SUPPRESS_MS (1s).
    await user.click(hintButton);
    await user.click(hintButton);

    await screen.findByText("reply");
    expect(chatCalls).toHaveLength(1);
  });
});

/* --------------------------------------------------------------------------
   #392: deleting a conversation whose history is still loading.

   `tutorConversationId` is only assigned once a history fetch resolves, so a
   conversation that has been clicked but not yet opened fails an
   `id === tutorConversationId` test. Deleting it left
   latestTutorSelectionRef pointing at the deleted id, and the in-flight
   fetch's own staleness check then PASSED -- opening a conversation that had
   just been deleted.
   -------------------------------------------------------------------------- */
describe("App delete during a pending selection (#392)", () => {
  const HOMEWORK_FIXTURE = {
    homeworks: [
      {
        id: "hw-1",
        courseId: "course-a",
        // #304 (merge): App reads StudentHomeworkSummary.courseName for the
        // top nav's course label. Every other fixture in this file carries
        // it; these two were written against the pre-#304 App, where the
        // label was a hardcoded stand-in, so omitting it crashed TopNav.
        courseName: "STATS 311",
        title: "HW 3",
        description: "d",
        dueDate: "2099-01-01T00:00:00.000Z",
        completedPercentage: 0,
        inProgressPercentage: 0,
        sections: [{ id: "s1", title: "Sec 1", order: 1, status: "in_progress", conversationId: "sec-conv-1" }],
      },
    ],
  };
  const CONV_B = {
    id: "conv-b",
    kind: "tutor",
    title: "Chat B",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    messageCount: 2,
  };

  it("does not leave a conversation displayed when it opens mid-delete (#401)", async () => {
    /* The other ordering. #392 covered "history still pending when the
       delete finishes"; this is "history RESOLVES during the delete". The
       old code compared `id === tutorConversationId` after the await, reading
       a value captured before it -- so a conversation that became current
       mid-delete was never torn down. Fixed by invalidating the selection
       BEFORE awaiting, which removes the race rather than detecting it. */
    vi.stubGlobal("CSS", { supports: () => true });
    Element.prototype.scrollIntoView = vi.fn();
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    };

    let releaseHistory!: (r: Response) => void;
    let releaseDelete!: (r: Response) => void;
    const hangingHistory = new Promise<Response>((r) => (releaseHistory = r));
    const hangingDelete = new Promise<Response>((r) => (releaseDelete = r));

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
          return new Response(JSON.stringify({ items: [CONV_B], nextCursor: null }), { status: 200 });
        }
        if (url === "/api/conversations/conv-b" && init?.method === "DELETE") return hangingDelete;
        if (url.startsWith("/api/conversations/conv-b/messages")) return hangingHistory;
        if (url.startsWith("/api/conversations/sec-conv-1/messages")) {
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

    await userEvent.click(await screen.findByRole("button", { name: `Select conversation: ${CONV_B.title}` }));
    await userEvent.click(screen.getByRole("button", { name: `Delete conversation: ${CONV_B.title}` }));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));

    // The history lands WHILE the delete is still in flight.
    releaseHistory(new Response(JSON.stringify([]), { status: 200 }));
    await new Promise((r) => setTimeout(r, 0));
    releaseDelete(new Response(null, { status: 204 }));

    await waitFor(() => expect(screen.queryByText(CONV_B.title)).toBeNull());
    // The tutor surface must not be left mounted on a deleted conversation.
    expect(screen.queryByText(/TUTOR CHAT/)).toBeNull();
  });

  it("does not open a deleted conversation when its in-flight history lands", async () => {
    vi.stubGlobal("CSS", { supports: () => true });
    Element.prototype.scrollIntoView = vi.fn();
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    };

    let releaseHistory!: (r: Response) => void;
    const historyPromise = new Promise<Response>((r) => (releaseHistory = r));

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
          return new Response(JSON.stringify({ items: [CONV_B], nextCursor: null }), { status: 200 });
        }
        if (url === "/api/conversations/conv-b" && init?.method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        if (url.startsWith("/api/conversations/conv-b/messages")) return historyPromise;
        if (url.startsWith("/api/conversations/sec-conv-1/messages")) {
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

    // Select conversation B -- its history request hangs, so selection is
    // pending and tutorConversationId is still undefined.
    const row = await screen.findByRole("button", { name: `Select conversation: ${CONV_B.title}` });
    await userEvent.click(row);

    // Delete it while that fetch is still in flight.
    await userEvent.click(screen.getByRole("button", { name: `Delete conversation: ${CONV_B.title}` }));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByText(CONV_B.title)).toBeNull());

    // Now let the history land. Before the fix, the staleness guard passed
    // and the deleted conversation opened.
    releaseHistory(new Response(JSON.stringify([]), { status: 200 }));

    // The distinguishing signal is which SURFACE is mounted, not the title:
    // the title is looked up from the rail list, and the deleted row is
    // already gone from it, so no title renders whether the conversation
    // opened or not. "TUTOR CHAT" is the tutor column's own breadcrumb
    // (#397 dropped the course prefix; the nav carries it) and appears only
    // while a tutor conversation is active.
    await waitFor(() => expect(screen.queryByText(CONV_B.title)).toBeNull());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText(/TUTOR CHAT/)).toBeNull();
    // ...and the section chat is still the surface on screen.
    expect(screen.getAllByText(/Section 1/).length).toBeGreaterThan(0);
  });
});

/* --------------------------------------------------------------------------
   #398: a superseded selection must not leave its row permanently busy.

   The pending marker was cleared only by the request that was still
   current. When the student navigated away instead of selecting something
   else, nobody cleared it -- the row stayed aria-busy and the repeat-click
   guard then refused to reselect it, until reload.
   -------------------------------------------------------------------------- */
describe("App superseded tutor selection (#398)", () => {
  const HOMEWORK_FIXTURE = {
    homeworks: [
      {
        id: "hw-1",
        courseId: "course-a",
        // #304 (merge): App reads StudentHomeworkSummary.courseName for the
        // top nav's course label. Every other fixture in this file carries
        // it; these two were written against the pre-#304 App, where the
        // label was a hardcoded stand-in, so omitting it crashed TopNav.
        courseName: "STATS 311",
        title: "HW 3",
        description: "d",
        dueDate: "2099-01-01T00:00:00.000Z",
        completedPercentage: 0,
        inProgressPercentage: 0,
        sections: [{ id: "s1", title: "Sec 1", order: 1, status: "in_progress", conversationId: "sec-conv-1" }],
      },
    ],
  };
  const CONV_B = {
    id: "conv-b",
    kind: "tutor",
    title: "Chat B",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    messageCount: 2,
  };

  it("clears the pending row when the student navigates to a section instead", async () => {
    vi.stubGlobal("CSS", { supports: () => true });
    Element.prototype.scrollIntoView = vi.fn();

    let releaseHistory!: (r: Response) => void;
    const hanging = new Promise<Response>((r) => (releaseHistory = r));

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
          return new Response(JSON.stringify({ items: [CONV_B], nextCursor: null }), { status: 200 });
        }
        if (url.startsWith("/api/conversations/conv-b/messages")) return hanging;
        if (url.startsWith("/api/conversations/sec-conv-1/messages")) {
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

    // Select B -- its history hangs, so the row goes pending.
    await userEvent.click(await screen.findByRole("button", { name: `Select conversation: ${CONV_B.title}` }));
    await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).not.toBeNull());

    // Navigate to a homework section instead of picking another conversation.
    await userEvent.click(screen.getByRole("button", { name: /Sec 1/ }));

    // The abandoned row must not stay busy: if it does, the repeat-click
    // guard makes it unselectable for the rest of the session.
    await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeNull());

    releaseHistory(new Response(JSON.stringify([]), { status: 200 }));
  });
});

/* #280 (requirement 2, transcript half). The regression: `limit`/`before`
   appeared ZERO times in the entire client, so the messages route's 200-row
   page was a silent hard ceiling -- message 201 and back was unreachable
   from every surface, including the head of the student's own thread.

   The cursor is a real `seq` taken from a row this same route returned
   (#280 requirement 1 added `seq` to the wire shape precisely so this is
   possible without a second round-trip) -- not a reconstructed value. */
describe("App tutor transcript load-older (#280)", () => {
  // No sections -- this covers the tutor surface, which is reached by
  // clicking a rail row rather than by section auto-selection.
  const TUTOR_ONLY_FIXTURE = {
    homeworks: [
      {
        id: "hw-1",
        courseId: "course-a",
        courseName: "STATS 311",
        title: "HW 3",
        description: "d",
        dueDate: "2099-01-01T00:00:00.000Z",
        completedPercentage: 0,
        inProgressPercentage: 0,
        sections: [],
      },
    ],
  };
  const PAGE_SIZE = 200;
  // Page 1 is the most recent PAGE_SIZE messages, oldest-first, seq
  // 201..400. A full page is what makes `hasMoreHistory` true, which is
  // what renders the control -- so it has to be genuinely full.
  const PAGE_ONE = Array.from({ length: PAGE_SIZE }, (_, i) => ({
    id: `m${201 + i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    parts: [{ type: "text", text: `recent message ${201 + i}` }],
    seq: 201 + i,
    createdAt: "2026-01-02T00:00:00.000Z",
  }));
  const OLDER_PAGE = [
    {
      id: "m200",
      role: "assistant" as const,
      parts: [{ type: "text", text: "the very first thing the tutor said" }],
      seq: 200,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ];

  it("pages back with before=<oldest loaded seq> and PREPENDS the result", async () => {
    vi.stubGlobal("CSS", { supports: () => true });
    Element.prototype.scrollIntoView = vi.fn();

    const messagesUrls: string[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/profile") return new Response(JSON.stringify({}), { status: 200 });
        if (url === "/api/hello") {
          return new Response(JSON.stringify({ message: "ok", ping_id: "1".repeat(8) }), { status: 200 });
        }
        if (url === "/api/student/homeworks") {
          return new Response(JSON.stringify(TUTOR_ONLY_FIXTURE), { status: 200 });
        }
        if (url.startsWith("/api/conversations?courseId=")) {
          return new Response(
            JSON.stringify({
              items: [
                { id: "t1", title: "Long tutor chat", updatedAt: "2026-01-01T00:00:00.000Z", messageCount: 401 },
              ],
              nextCursor: null,
            }),
            { status: 200 },
          );
        }
        if (url.startsWith("/api/conversations/t1/messages")) {
          messagesUrls.push(url);
          const isOlderPage = url.includes("before=");
          return new Response(JSON.stringify(isOlderPage ? OLDER_PAGE : PAGE_ONE), { status: 200 });
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

    const user = userEvent.setup();
    await user.click(await screen.findByText("Long tutor chat"));

    // A full first page means older messages exist, so the control renders.
    const loadOlder = await screen.findByRole("button", { name: /load older messages/i });
    expect(screen.queryByText("the very first thing the tutor said")).toBeNull();

    await user.click(loadOlder);

    await waitFor(() => expect(screen.getByText("the very first thing the tutor said")).toBeTruthy());

    // The cursor is the oldest LOADED message's seq (page 1's head, 201) --
    // exclusive, so seq 200 is exactly what comes back. Asserting the URL,
    // not merely "a second call happened": a request without `before` would
    // re-fetch page 1 and the transcript would still look "loaded".
    expect(messagesUrls).toEqual([
      "/api/conversations/t1/messages?limit=200",
      "/api/conversations/t1/messages?limit=200&before=201",
    ]);

    // Prepended, not appended: the older message must render ABOVE the
    // page-1 messages it precedes, or the transcript reads out of order.
    const oldest = screen.getByText("the very first thing the tutor said");
    const firstOfPageOne = screen.getByText("recent message 201");
    expect(oldest.compareDocumentPosition(firstOfPageOne) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // The older page was short (1 < 200), so there is nothing left to ask
    // for and the control retires rather than offering an empty page.
    await waitFor(() => expect(screen.queryByRole("button", { name: /load older messages/i })).toBeNull());
  });

  it("a newly created conversation starts with no history affordance, not the previous conversation's cursor", async () => {
    /* Final review: "New conversation" went through selectTutorConversation,
       which sets the id and the seed messages but owns none of the pagination
       state -- so the hasMore/oldestSeq belonging to the conversation that was
       previously open survived into a conversation seconds old. The UI then
       claimed history exists for a thread that has none, and clicking the
       button sent the OLD conversation's cursor at the NEW conversation's
       endpoint. */
    vi.stubGlobal("CSS", { supports: () => true });
    Element.prototype.scrollIntoView = vi.fn();

    const messagesUrls: string[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/profile") return new Response(JSON.stringify({}), { status: 200 });
        if (url === "/api/hello") {
          return new Response(JSON.stringify({ message: "ok", ping_id: "1".repeat(8) }), { status: 200 });
        }
        if (url === "/api/student/homeworks") {
          return new Response(JSON.stringify(TUTOR_ONLY_FIXTURE), { status: 200 });
        }
        if (url === "/api/conversations" && init?.method === "POST") {
          return new Response(
            JSON.stringify({
              id: "t2",
              kind: "tutor",
              title: "New conversation",
              createdAt: "2026-01-03T00:00:00.000Z",
              updatedAt: "2026-01-03T00:00:00.000Z",
            }),
            { status: 201 },
          );
        }
        if (url.startsWith("/api/conversations?courseId=")) {
          return new Response(
            JSON.stringify({
              items: [
                { id: "t1", title: "Long tutor chat", updatedAt: "2026-01-01T00:00:00.000Z", messageCount: 401 },
              ],
              nextCursor: null,
            }),
            { status: 200 },
          );
        }
        if (url.startsWith("/api/conversations/t1/messages")) {
          messagesUrls.push(url);
          return new Response(JSON.stringify(url.includes("before=") ? OLDER_PAGE : PAGE_ONE), { status: 200 });
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

    const user = userEvent.setup();
    await user.click(await screen.findByText("Long tutor chat"));
    // t1 is at the page cap, so it legitimately offers older history.
    expect(await screen.findByRole("button", { name: /load older messages/i })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /new conversation/i }));

    // The brand-new, empty conversation must not inherit t1's claim that
    // there is more history to load.
    await waitFor(() => expect(screen.queryByRole("button", { name: /load older messages/i })).toBeNull());
    // And in particular t1's cursor was never fired at t2's endpoint.
    expect(messagesUrls).toEqual(["/api/conversations/t1/messages?limit=200"]);
  });
});

/* Final review: the SECTION surface's half of #280 had no App-level test at
   all -- only the tutor surface above did. The two surfaces run separate
   useChat instances, separate cursors and separate staleness refs (they share
   only fetchConversationHistory), so the tutor test proves nothing about this
   one. The gap is what let the section surface keep a stale cursor across a
   failed hydration; the second test here is that specific defect. */
describe("App section transcript load-older", () => {
  const PAGE_SIZE = 200;
  const homeworkFixture = (sections: unknown[]) => ({
    homeworks: [
      {
        id: "hw-1",
        courseId: "course-a",
        courseName: "STATS 311",
        title: "HW 3",
        description: "d",
        dueDate: "2099-01-01T00:00:00.000Z",
        completedPercentage: 0,
        inProgressPercentage: 0,
        sections,
      },
    ],
  });
  // Full page => hasMore, which is what renders the control. seq 201..400.
  const pageOne = (label: string) =>
    Array.from({ length: PAGE_SIZE }, (_, i) => ({
      id: `${label}-m${201 + i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      parts: [{ type: "text", text: `${label} recent message ${201 + i}` }],
      seq: 201 + i,
      createdAt: "2026-01-02T00:00:00.000Z",
    }));

  it("pages back with before=<oldest loaded seq> and PREPENDS the result", async () => {
    vi.stubGlobal("CSS", { supports: () => true });
    Element.prototype.scrollIntoView = vi.fn();

    const messagesUrls: string[] = [];
    const olderPage = [
      {
        id: "s1-m200",
        role: "assistant" as const,
        parts: [{ type: "text", text: "the very first thing this section said" }],
        seq: 200,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/profile") return new Response(JSON.stringify({}), { status: 200 });
        if (url === "/api/hello") {
          return new Response(JSON.stringify({ message: "ok", ping_id: "1".repeat(8) }), { status: 200 });
        }
        if (url === "/api/student/homeworks") {
          return new Response(
            JSON.stringify(
              homeworkFixture([{ id: "s1", title: "Sec 1", order: 1, status: "in_progress", conversationId: "sec-conv-1" }]),
            ),
            { status: 200 },
          );
        }
        if (url.startsWith("/api/conversations?")) {
          return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
        }
        if (url.endsWith("/hints")) {
          return new Response(JSON.stringify({ count: 0, limit: null, remaining: null }), { status: 200 });
        }
        if (url.startsWith("/api/conversations/sec-conv-1/messages")) {
          messagesUrls.push(url);
          return new Response(JSON.stringify(url.includes("before=") ? olderPage : pageOne("s1")), { status: 200 });
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

    // Sec 1 auto-selects on mount and hydrates a full page, so older
    // messages exist and the control renders.
    const loadOlder = await screen.findByRole("button", { name: /load older messages/i });
    expect(screen.queryByText("the very first thing this section said")).toBeNull();

    const user = userEvent.setup();
    await user.click(loadOlder);

    await waitFor(() => expect(screen.getByText("the very first thing this section said")).toBeTruthy());

    // The cursor is the oldest LOADED seq (page 1's head, 201), exclusive.
    // Asserting the URL, not just "a second call happened": a request without
    // `before` would re-fetch page 1 and still look "loaded".
    expect(messagesUrls).toEqual([
      "/api/conversations/sec-conv-1/messages?limit=200",
      "/api/conversations/sec-conv-1/messages?limit=200&before=201",
    ]);

    // Prepended, not appended -- or the transcript reads out of order.
    const oldest = screen.getByText("the very first thing this section said");
    const firstOfPageOne = screen.getByText("s1 recent message 201");
    expect(oldest.compareDocumentPosition(firstOfPageOne) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Short older page (1 < 200) -- nothing left to ask for, control retires.
    await waitFor(() => expect(screen.queryByRole("button", { name: /load older messages/i })).toBeNull());
  });

  it("drops the pagination cursor when a section switch fails to hydrate, so load-older can't splice the new section's history into the old one's transcript", async () => {
    /* The defect: #276 deliberately leaves the PREVIOUS section's messages on
       screen when hydration fails (failing closed beats blanking the
       transcript), while `conversationId` and latestSectionConversationRef
       have already moved to the NEW section. The failure path cleared
       sectionHydrationError's sibling state but not the cursor, so
       `hasMoreHistory` stayed true from sec 1 and "Load older messages" was
       still offered -- and clicking it PASSED the staleness guard (which
       correctly checks the new section) and prepended sec 2's older page onto
       sec 1's still-rendered transcript. The tutor surface's own failure path
       has always cleared its cursor; this was the asymmetry. */
    vi.stubGlobal("CSS", { supports: () => true });
    Element.prototype.scrollIntoView = vi.fn();

    const messagesUrls: string[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/profile") return new Response(JSON.stringify({}), { status: 200 });
        if (url === "/api/hello") {
          return new Response(JSON.stringify({ message: "ok", ping_id: "1".repeat(8) }), { status: 200 });
        }
        if (url === "/api/student/homeworks") {
          return new Response(
            JSON.stringify(
              homeworkFixture([
                { id: "s1", title: "Sec 1", order: 1, status: "in_progress", conversationId: "sec-conv-1" },
                { id: "s2", title: "Sec 2", order: 2, status: "in_progress", conversationId: "sec-conv-2" },
              ]),
            ),
            { status: 200 },
          );
        }
        if (url.startsWith("/api/conversations?")) {
          return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
        }
        if (url.endsWith("/hints")) {
          return new Response(JSON.stringify({ count: 0, limit: null, remaining: null }), { status: 200 });
        }
        if (url.startsWith("/api/conversations/sec-conv-1/messages")) {
          messagesUrls.push(url);
          return new Response(JSON.stringify(pageOne("s1")), { status: 200 });
        }
        if (url.startsWith("/api/conversations/sec-conv-2/messages")) {
          messagesUrls.push(url);
          // Sec 2's hydration fails. Its older-page request, if the buggy
          // build ever makes one, would succeed and be the visible splice.
          if (url.includes("before=")) {
            return new Response(
              JSON.stringify([
                {
                  id: "s2-m200",
                  role: "assistant",
                  parts: [{ type: "text", text: "SEC 2 OLDER MESSAGE" }],
                  seq: 200,
                  createdAt: "2026-01-01T00:00:00.000Z",
                },
              ]),
              { status: 200 },
            );
          }
          return new Response(JSON.stringify({ error: "server unavailable" }), { status: 503 });
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

    // Sec 1 hydrates a full page -- cursor set, control offered.
    expect(await screen.findByRole("button", { name: /load older messages/i })).toBeTruthy();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Sec 2/ }));

    expect(await screen.findByText(/Couldn't load this section's conversation/i)).toBeTruthy();
    // #276's behaviour, unchanged: sec 1's transcript is still on screen
    // rather than blanked. That is precisely what makes a stale cursor
    // dangerous, so the test asserts it rather than assuming it.
    expect(screen.getByText("s1 recent message 201")).toBeTruthy();

    // No cursor => no affordance. Before the fix this button was still
    // rendered (sec 1's `hasMore` survived the failure).
    await waitFor(() => expect(screen.queryByRole("button", { name: /load older messages/i })).toBeNull());

    // And nothing ever asked sec 2 for a page it would have spliced in.
    expect(messagesUrls.some((u) => u.includes("before="))).toBe(false);
    expect(screen.queryByText("SEC 2 OLDER MESSAGE")).toBeNull();
  });
});
